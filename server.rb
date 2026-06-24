require 'webrick'
require 'sqlite3'
require 'json'
require 'fileutils'
require 'socket'
require 'date'

STDOUT.sync = true

# Path to SQLite database
DB_PATH = File.join(File.dirname(__FILE__), 'data.db')

# Ensure public directory exists
FileUtils.mkdir_p(File.join(File.dirname(__FILE__), 'public'))

# Initialize database schema
def init_db
  db = SQLite3::Database.new(DB_PATH)
  db.results_as_hash = true

  db.execute <<-SQL
    CREATE TABLE IF NOT EXISTS company_info (
      id INTEGER PRIMARY KEY,
      name TEXT,
      address TEXT,
      phone TEXT,
      email TEXT
    );
  SQL

  db.execute <<-SQL
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      name TEXT,
      role TEXT
    );
  SQL

  db.execute <<-SQL
    CREATE TABLE IF NOT EXISTS cash_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cash_type TEXT, -- 'principale' or 'exploitation'
      date TEXT,
      status TEXT, -- 'open' or 'closed'
      opening_balance REAL,
      closing_balance REAL,
      opened_by TEXT,
      closed_by TEXT,
      opened_at TEXT,
      closed_at TEXT,
      billetage TEXT -- JSON string
    );
  SQL

  db.execute <<-SQL
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cash_day_id INTEGER,
      cash_type TEXT, -- 'principale' or 'exploitation'
      type TEXT, -- 'entree' or 'sortie'
      category TEXT,
      nature TEXT, -- 'Nature de l'opération'
      object TEXT, -- 'Objet du décaissement'
      amount REAL,
      beneficiary_type TEXT, -- 'acheteuse', 'fournisseur', 'banque', 'autre' or NULL
      beneficiary_name TEXT,
      needs_justification INTEGER DEFAULT 0, -- 0 or 1
      is_justified INTEGER DEFAULT 0, -- 0 or 1
      justified_at TEXT,
      created_at TEXT,
      created_by TEXT,
      transfer_id INTEGER, -- links matching transfer transaction
      reconciliation_id INTEGER -- links to reconciliations table
    );
  SQL

  db.execute <<-SQL
    CREATE TABLE IF NOT EXISTS reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_start TEXT,
      date_end TEXT,
      created_at TEXT,
      created_by TEXT,
      status TEXT, -- 'pending_raf', 'validated_raf', 'finalized'
      validated_at TEXT,
      validated_by TEXT,
      total_outflow REAL,
      total_spent REAL,
      gap REAL,
      finalized_transaction_id INTEGER
    );
  SQL

  db.execute <<-SQL
    CREATE TABLE IF NOT EXISTS reconciliation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER,
      transaction_id INTEGER,
      outflow_amount REAL,
      spent_amount REAL,
      gap REAL
    );
  SQL

  db.close
end

init_db

# Helper to fetch active DB connection
def get_db
  db = SQLite3::Database.new(DB_PATH)
  db.results_as_hash = true
  db
end

# API Handler Servlet
class APIServlet < WEBrick::HTTPServlet::AbstractServlet
  def do_GET(req, res)
    handle_request(req, res)
  end

  def do_POST(req, res)
    handle_request(req, res)
  end

  def do_OPTIONS(req, res)
    res.status = 200
    set_headers(res)
  end

  private

  def normalize_utf8(obj)
    if obj.is_a?(String)
      obj.dup.force_encoding('UTF-8')
    elsif obj.is_a?(Hash)
      new_h = {}
      obj.each { |k, v| new_h[normalize_utf8(k)] = normalize_utf8(v) }
      new_h
    elsif obj.is_a?(Array)
      obj.map { |v| normalize_utf8(v) }
    else
      obj
    end
  end

  def set_headers(res)
    res['Content-Type'] = 'application/json; charset=utf-8'
    res['Access-Control-Allow-Origin'] = '*'
    res['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS, PUT, DELETE'
    res['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
  end

  def send_json(res, status_code, data)
    res.status = status_code
    set_headers(res)
    res.body = JSON.generate(data)
  end

  def send_error(res, status_code, message)
    send_json(res, status_code, { error: message })
  end

  def handle_request(req, res)
    path = req.path
    method = req.request_method
    db = get_db
    query_params = normalize_utf8(req.query || {})
    puts "PATH: #{path}, METHOD: #{method}, QUERY: #{query_params.inspect}"

    # Parse body if JSON
    body_data = {}
    if method == 'POST' && req.body
      begin
        body_data = JSON.parse(req.body)
        body_data = normalize_utf8(body_data)
      rescue JSON::ParserError
        # Ignore or log parser error
      end
    end

    case path
    # ================= AUTH & SETUP =================
    when '/api/auth/setup_needed'
      # Checks if any RAF admin is registered
      row = db.get_first_row("SELECT COUNT(*) as count FROM users WHERE role = 'raf'")
      setup_needed = row['count'] == 0
      send_json(res, 200, { setup_needed: setup_needed })

    when '/api/auth/setup'
      if method == 'POST'
        # Verify setup is actually needed
        count = db.get_first_row("SELECT COUNT(*) as count FROM users WHERE role = 'raf'")['count']
        if count > 0
          send_error(res, 400, "L'application est déjà initialisée.")
          return
        end

        # Create RAF user and company info
        username = body_data['username']
        password = body_data['password']
        name = body_data['name']
        company_name = body_data['company_name']
        company_address = body_data['company_address']
        company_phone = body_data['company_phone']
        company_email = body_data['company_email']

        if !username || !password || !name || !company_name
          send_error(res, 400, "Veuillez remplir tous les champs obligatoires (nom, identifiant, mot de passe, nom entreprise).")
          return
        end

        db.transaction do
          db.execute("INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, 'raf')", [username, password, name])
          db.execute("INSERT INTO company_info (name, address, phone, email) VALUES (?, ?, ?, ?)", [company_name, company_address, company_phone, company_email])
        end

        send_json(res, 200, { success: true, message: "Administration et entreprise configurées avec succès !" })
      else
        send_error(res, 405, "Méthode non autorisée")
      end

    when '/api/auth/login'
      if method == 'POST'
        username = body_data['username']
        password = body_data['password']

        user = db.get_first_row("SELECT * FROM users WHERE username = ? AND password = ?", [username, password])
        if user
          send_json(res, 200, {
            success: true,
            user: {
              id: user['id'],
              username: user['username'],
              name: user['name'],
              role: user['role']
            }
          })
        else
          send_error(res, 401, "Identifiants incorrects. Veuillez réessayer.")
        end
      else
        send_error(res, 405, "Méthode non autorisée")
      end

    # ================= COMPANY INFO =================
    when '/api/company'
      if method == 'GET'
        company = db.get_first_row("SELECT * FROM company_info ORDER BY id DESC LIMIT 1")
        send_json(res, 200, company || {})
      elsif method == 'POST'
        name = body_data['name']
        address = body_data['address']
        phone = body_data['phone']
        email = body_data['email']

        db.execute("DELETE FROM company_info")
        db.execute("INSERT INTO company_info (name, address, phone, email) VALUES (?, ?, ?, ?)", [name, address, phone, email])
        send_json(res, 200, { success: true, message: "Informations de l'entreprise mises à jour." })
      else
        send_error(res, 405, "Méthode non autorisée")
      end

    # ================= USER MANAGEMENT =================
    when '/api/users'
      if method == 'GET'
        users = db.execute("SELECT id, username, name, role FROM users")
        send_json(res, 200, users)
      elsif method == 'POST'
        username = body_data['username']
        password = body_data['password']
        name = body_data['name']
        role = body_data['role'] # 'raf' or 'caissiere'

        if !username || !password || !name || !role
          send_error(res, 400, "Veuillez fournir toutes les informations de l'agent.")
          return
        end

        begin
          db.execute("INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)", [username, password, name, role])
          send_json(res, 200, { success: true, message: "Agent créé avec succès." })
        rescue SQLite3::ConstraintException
          send_error(res, 400, "Cet identifiant est déjà utilisé.")
        end
      else
        send_error(res, 405, "Méthode non autorisée")
      end

    # ================= CASH DAYS (OPEN/CLOSE) =================
    when '/api/cash/status'
      # Get status of both cash systems
      resp = {}
      ['principale', 'exploitation'].each do |type|
        row = db.get_first_row(<<-SQL, [type])
          SELECT cd.*, 
            (cd.opening_balance + 
             COALESCE((SELECT SUM(amount) FROM transactions WHERE cash_day_id = cd.id AND type = 'entree'), 0) - 
             COALESCE((SELECT SUM(amount) FROM transactions WHERE cash_day_id = cd.id AND type = 'sortie'), 0)
            ) AS current_balance
          FROM cash_days cd
          WHERE cd.cash_type = ?
          ORDER BY cd.id DESC LIMIT 1
        SQL
        
        resp[type] = row || { status: 'closed', balance: 0.0 }
      end
      send_json(res, 200, resp)

    when '/api/cash/open'
      if method == 'POST'
        cash_type = body_data['cash_type']
        date_str = body_data['date'] # YYYY-MM-DD
        opening_balance = body_data['opening_balance'].to_f
        opened_by = body_data['opened_by']

        # Verify no cash day is already open for this type
        last_day = db.get_first_row("SELECT * FROM cash_days WHERE cash_type = ? ORDER BY id DESC LIMIT 1", [cash_type])
        if last_day && last_day['status'] == 'open'
          send_error(res, 400, "La caisse #{cash_type} est déjà ouverte.")
          return
        end

        now_str = Time.now.strftime('%Y-%m-%d %H:%M:%S')
        db.execute(<<-SQL, [cash_type, date_str, 'open', opening_balance, opened_by, now_str])
          INSERT INTO cash_days (cash_type, date, status, opening_balance, opened_by, opened_at)
          VALUES (?, ?, ?, ?, ?, ?)
        SQL

        send_json(res, 200, { success: true, message: "Caisse ouverte avec succès." })
      else
        send_error(res, 405, "Méthode non autorisée")
      end

    when '/api/cash/close'
      if method == 'POST'
        cash_type = body_data['cash_type']
        closing_balance = body_data['closing_balance'].to_f
        closed_by = body_data['closed_by']
        billetage = body_data['billetage'].to_json # Store JSON representation

        # Verify cash day is open
        last_day = db.get_first_row("SELECT * FROM cash_days WHERE cash_type = ? ORDER BY id DESC LIMIT 1", [cash_type])
        if !last_day || last_day['status'] != 'open'
          send_error(res, 400, "Aucune session de caisse ouverte pour enregistrer la fermeture.")
          return
        end

        now_str = Time.now.strftime('%Y-%m-%d %H:%M:%S')
        db.execute(<<-SQL, [closing_balance, closed_by, now_str, billetage, last_day['id']])
          UPDATE cash_days
          SET status = 'closed', closing_balance = ?, closed_by = ?, closed_at = ?, billetage = ?
          WHERE id = ?
        SQL

        send_json(res, 200, { success: true, message: "Caisse fermée avec succès." })
      else
        send_error(res, 405, "Méthode non autorisée")
      end

    # ================= TRANSACTIONS =================
    when '/api/transactions'
      if method == 'GET'
        # Get all transactions
        transactions = db.execute("SELECT * FROM transactions ORDER BY id DESC LIMIT 200")
        send_json(res, 200, transactions)
      elsif method == 'POST'
        cash_type = body_data['cash_type']
        type = body_data['type'] # 'entree' or 'sortie'
        category = body_data['category']
        nature = body_data['nature']
        object = body_data['object']
        amount = body_data['amount'].to_f
        beneficiary_type = body_data['beneficiary_type']
        beneficiary_name = body_data['beneficiary_name']
        needs_justification = body_data['needs_justification'] ? 1 : 0
        created_by = body_data['created_by']

        # Get active cash day
        cash_day = db.get_first_row("SELECT * FROM cash_days WHERE cash_type = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [cash_type])
        if !cash_day
          send_error(res, 400, "Impossible d'enregistrer une opération : la caisse #{cash_type} n'est pas ouverte.")
          return
        end

        # If it is a Sortie in Caisse Principale, beneficiary_type is mandatory
        if cash_type == 'principale' && type == 'sortie' && !beneficiary_type
          send_error(res, 400, "Le type de bénéficiaire est requis pour les sorties de la caisse principale.")
          return
        end

        now_str = Time.now.strftime('%Y-%m-%d %H:%M:%S')
        db.execute(<<-SQL, [cash_day['id'], cash_type, type, category, nature, object, amount, beneficiary_type, beneficiary_name, needs_justification, 0, now_str, created_by])
          INSERT INTO transactions (cash_day_id, cash_type, type, category, nature, object, amount, beneficiary_type, beneficiary_name, needs_justification, is_justified, created_at, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        SQL

        send_json(res, 200, { success: true, message: "Opération enregistrée avec succès." })
      else
        send_error(res, 405, "Méthode non autorisée")
      end

    when '/api/transactions/today'
      cash_type = query_params['cash_type'] ? query_params['cash_type'].to_s : nil
      day = db.get_first_row("SELECT id FROM cash_days WHERE cash_type = ? ORDER BY id DESC LIMIT 1", [cash_type])
      if day
        txs = db.execute("SELECT * FROM transactions WHERE cash_day_id = ? ORDER BY id DESC", [day['id']])
        send_json(res, 200, txs)
      else
        send_json(res, 200, [])
      end

    when '/api/transactions/justify'
      if method == 'POST'
        tx_id = body_data['transaction_id'].to_i
        now_str = Time.now.strftime('%Y-%m-%d %H:%M:%S')

        db.execute("UPDATE transactions SET is_justified = 1, justified_at = ? WHERE id = ?", [now_str, tx_id])
        send_json(res, 200, { success: true, message: "La pièce a été marquée comme justifiée." })
      else
        send_error(res, 405, "Méthode non autorisée")
      end

    when '/api/transactions/search'
      # Multi-criteria search
      cash_type = query_params['cash_type'] ? query_params['cash_type'].to_s : nil
      type = query_params['type'] ? query_params['type'].to_s : nil
      date_start = query_params['date_start'] ? query_params['date_start'].to_s : nil
      date_end = query_params['date_end'] ? query_params['date_end'].to_s : nil
      category = query_params['category'] ? query_params['category'].to_s : nil
      beneficiary_type = query_params['beneficiary_type'] ? query_params['beneficiary_type'].to_s : nil
      is_justified = query_params['is_justified'] ? query_params['is_justified'].to_s : nil
      query = query_params['query'] ? query_params['query'].to_s : nil

      sql = "SELECT t.*, cd.date as cash_date FROM transactions t JOIN cash_days cd ON t.cash_day_id = cd.id WHERE 1=1"
      params = []

      if cash_type && cash_type != ''
        sql += " AND t.cash_type = ?"
        params << cash_type
      end
      if type && type != ''
        sql += " AND t.type = ?"
        params << type
      end
      if date_start && date_start != ''
        sql += " AND cd.date >= ?"
        params << date_start
      end
      if date_end && date_end != ''
        sql += " AND cd.date <= ?"
        params << date_end
      end
      if category && category != ''
        sql += " AND t.category = ?"
        params << category
      end
      if beneficiary_type && beneficiary_type != ''
        sql += " AND t.beneficiary_type = ?"
        params << beneficiary_type
      end
      if is_justified && is_justified != ''
        sql += " AND t.is_justified = ?"
        params << (is_justified == 'true' ? 1 : 0)
      end
      if query && query != ''
        sql += " AND (t.nature LIKE ? OR t.object LIKE ? OR t.beneficiary_name LIKE ? OR t.amount LIKE ?)"
        term = "%#{query}%"
        params += [term, term, term, term]
      end

      sql += " ORDER BY t.id DESC LIMIT 300"
      
      results = db.execute(sql, params)
      send_json(res, 200, results)

    # ================= TRANSFERS =================
    when '/api/transactions/transfer'
      if method == 'POST'
        source = body_data['source_cash_type'] # 'principale' or 'exploitation'
        target = body_data['target_cash_type']
        amount = body_data['amount'].to_f
        created_by = body_data['created_by']

        if source == target
          send_error(res, 400, "Le transfert doit s'effectuer entre deux caisses distinctes.")
          return
        end

        # Verify BOTH cash registers are open
        src_day = db.get_first_row("SELECT * FROM cash_days WHERE cash_type = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [source])
        tgt_day = db.get_first_row("SELECT * FROM cash_days WHERE cash_type = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [target])

        if !src_day
          send_error(res, 400, "La caisse source (#{source}) n'est pas ouverte.")
          return
        end
        if !tgt_day
          send_error(res, 400, "La caisse cible (#{target}) n'est pas ouverte.")
          return
        end

        # Check source balance
        # Computed balance = opening + entries - sorties
        src_bal = db.get_first_row(<<-SQL, [src_day['id']])
          SELECT (cd.opening_balance + 
            COALESCE((SELECT SUM(amount) FROM transactions WHERE cash_day_id = cd.id AND type = 'entree'), 0) - 
            COALESCE((SELECT SUM(amount) FROM transactions WHERE cash_day_id = cd.id AND type = 'sortie'), 0)
          ) AS balance FROM cash_days cd WHERE cd.id = ?
        SQL

        if src_bal['balance'] < amount
          send_error(res, 400, "Fonds insuffisants dans la caisse source. Solde actuel : #{src_bal['balance']}.")
          return
        end

        now_str = Time.now.strftime('%Y-%m-%d %H:%M:%S')

        db.transaction do
          # Create Sortie in Source Caisse
          db.execute(<<-SQL, [src_day['id'], source, 'sortie', 'transfert_sortant', "Transfert vers caisse #{target}", "Transfert inter-caisse", amount, 'autre', "Caisse #{target}", 0, 0, now_str, created_by])
            INSERT INTO transactions (cash_day_id, cash_type, type, category, nature, object, amount, beneficiary_type, beneficiary_name, needs_justification, is_justified, created_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          SQL
          src_tx_id = db.last_insert_row_id

          # Create Entrée in Target Caisse
          db.execute(<<-SQL, [tgt_day['id'], target, 'entree', 'transfert_entrant', "Transfert depuis caisse #{source}", "Transfert inter-caisse", amount, 'autre', "Caisse #{source}", 0, 0, now_str, created_by])
            INSERT INTO transactions (cash_day_id, cash_type, type, category, nature, object, amount, beneficiary_type, beneficiary_name, needs_justification, is_justified, created_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          SQL
          tgt_tx_id = db.last_insert_row_id

          # Cross link transfer transactions
          db.execute("UPDATE transactions SET transfer_id = ? WHERE id = ?", [tgt_tx_id, src_tx_id])
          db.execute("UPDATE transactions SET transfer_id = ? WHERE id = ?", [src_tx_id, tgt_tx_id])
        end

        send_json(res, 200, { success: true, message: "Transfert inter-caisse effectué avec succès." })
      else
        send_error(res, 405, "Méthode non autorisée")
      end

    # ================= RECONCILIATIONS =================
    when '/api/reconciliations/prepare'
      if method == 'POST'
        date_start = body_data['date_start']
        date_end = body_data['date_end']

        # Find unreconciled outflows in Caisse Principale where beneficiary is 'acheteuse'
        query = <<-SQL
          SELECT t.*, cd.date as cash_date
          FROM transactions t
          JOIN cash_days cd ON t.cash_day_id = cd.id
          WHERE t.cash_type = 'principale'
            AND t.type = 'sortie'
            AND t.beneficiary_type = 'acheteuse'
            AND t.reconciliation_id IS NULL
            AND cd.date >= ?
            AND cd.date <= ?
          ORDER BY cd.date ASC
        SQL

        txs = db.execute(query, [date_start, date_end])
        send_json(res, 200, txs)
      else
        send_error(res, 405, "Méthode non autorisée")
      end

    when '/api/reconciliations/submit'
      if method == 'POST'
        date_start = body_data['date_start']
        date_end = body_data['date_end']
        created_by = body_data['created_by']
        items = body_data['items'] # [{ transaction_id, spent_amount }, ...]

        if items.nil? || items.empty?
          send_error(res, 400, "Aucune opération à régulariser fournie.")
          return
        end

        total_outflow = 0.0
        total_spent = 0.0

        # Read actual items and compute sums
        items_processed = []
        items.each do |item|
          tx_id = item['transaction_id'].to_i
          spent = item['spent_amount'].to_f
          
          tx = db.get_first_row("SELECT amount FROM transactions WHERE id = ?", [tx_id])
          if tx
            outflow = tx['amount'].to_f
            gap = outflow - spent
            total_outflow += outflow
            total_spent += spent
            items_processed << { tx_id: tx_id, outflow: outflow, spent: spent, gap: gap }
          end
        end

        overall_gap = total_outflow - total_spent
        now_str = Time.now.strftime('%Y-%m-%d %H:%M:%S')

        reconciliation_id = nil
        db.transaction do
          # Create reconciliation
          db.execute(<<-SQL, [date_start, date_end, now_str, created_by, 'pending_raf', total_outflow, total_spent, overall_gap])
            INSERT INTO reconciliations (date_start, date_end, created_at, created_by, status, total_outflow, total_spent, gap)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          SQL
          reconciliation_id = db.last_insert_row_id

          # Insert items and update transactions
          items_processed.each do |item|
            db.execute(<<-SQL, [reconciliation_id, item[:tx_id], item[:outflow], item[:spent], item[:gap]])
              INSERT INTO reconciliation_items (reconciliation_id, transaction_id, outflow_amount, spent_amount, gap)
              VALUES (?, ?, ?, ?, ?)
            SQL

            db.execute("UPDATE transactions SET reconciliation_id = ? WHERE id = ?", [reconciliation_id, item[:tx_id]])
          end
        end

        send_json(res, 200, { success: true, reconciliation_id: reconciliation_id, message: "Régularisation soumise avec succès pour validation du RAF." })
      else
        send_error(res, 405, "Méthode non autorisée")
      end

    when '/api/reconciliations/pending'
      # List reconciliations pending validation
      recs = db.execute("SELECT * FROM reconciliations WHERE status = 'pending_raf' ORDER BY id DESC")
      # Hydrate with items
      recs.map! do |rec|
        items = db.execute(<<-SQL, [rec['id']])
          SELECT ri.*, t.nature, t.object, t.created_at as tx_date, t.beneficiary_name
          FROM reconciliation_items ri
          JOIN transactions t ON ri.transaction_id = t.id
          WHERE ri.reconciliation_id = ?
        SQL
        rec['items'] = items
        rec
      end
      send_json(res, 200, recs)

    when '/api/reconciliations/status'
      # Return list of all reconciliations for the caissière view
      recs = db.execute("SELECT * FROM reconciliations ORDER BY id DESC LIMIT 100")
      recs.map! do |rec|
        items = db.execute(<<-SQL, [rec['id']])
          SELECT ri.*, t.nature, t.object, t.created_at as tx_date, t.beneficiary_name
          FROM reconciliation_items ri
          JOIN transactions t ON ri.transaction_id = t.id
          WHERE ri.reconciliation_id = ?
        SQL
        rec['items'] = items
        rec
      end
      send_json(res, 200, recs)

    when '/api/reconciliations/validate'
      if method == 'POST'
        rec_id = body_data['reconciliation_id'].to_i
        validated_by = body_data['validated_by']
        now_str = Time.now.strftime('%Y-%m-%d %H:%M:%S')

        # Check reconciliation exists and is pending
        rec = db.get_first_row("SELECT * FROM reconciliations WHERE id = ?", [rec_id])
        if !rec || rec['status'] != 'pending_raf'
          send_error(res, 400, "Régularisation introuvable ou déjà traitée.")
          return
        end

        db.execute(<<-SQL, [validated_by, now_str, rec_id])
          UPDATE reconciliations
          SET status = 'validated_raf', validated_by = ?, validated_at = ?
          WHERE id = ?
        SQL

        send_json(res, 200, { success: true, message: "Régularisation validée avec succès." })
      else
        send_error(res, 405, "Méthode non autorisée")
      end

    when '/api/reconciliations/finalize'
      if method == 'POST'
        rec_id = body_data['reconciliation_id'].to_i
        created_by = body_data['created_by']

        # Get reconciliation
        rec = db.get_first_row("SELECT * FROM reconciliations WHERE id = ?", [rec_id])
        if !rec || rec['status'] != 'validated_raf'
          send_error(res, 400, "Régularisation impossible à finaliser (doit être validée par le RAF d'abord).")
          return
        end

        # Get Caisse Principale open day
        cp_day = db.get_first_row("SELECT * FROM cash_days WHERE cash_type = 'principale' AND status = 'open' ORDER BY id DESC LIMIT 1")
        if !cp_day
          send_error(res, 400, "Impossible de finaliser : la caisse principale doit être ouverte pour enregistrer le mouvement d'écart.")
          return
        end

        gap = rec['gap'].to_f
        now_str = Time.now.strftime('%Y-%m-%d %H:%M:%S')
        final_tx_id = nil

        db.transaction do
          if gap != 0
            if gap > 0
              # Buyer spent less than outflow. Returns money to cash.
              # This is an Entrée in Caisse Principale.
              db.execute(<<-SQL, [cp_day['id'], 'principale', 'entree', 'regularisation', 'Retour en caisse régul acheteuse', "Écart positif régularisation \##{rec_id}", gap, 'acheteuse', 'Acheteuse', 0, 0, now_str, created_by])
                INSERT INTO transactions (cash_day_id, cash_type, type, category, nature, object, amount, beneficiary_type, beneficiary_name, needs_justification, is_justified, created_at, created_by)
                VALUES (?, 'principale', 'entree', 'regularisation', ?, ?, ?, 'acheteuse', 'Acheteuse', 0, 0, ?, ?)
              SQL
              final_tx_id = db.last_insert_row_id
            elsif gap < 0
              # Buyer spent more than outflow. Needs complementary outflow.
              # This is a Sortie in Caisse Principale.
              db.execute(<<-SQL, [cp_day['id'], 'principale', 'sortie', 'regularisation', 'Décaissement complém régul acheteuse', "Écart négatif régularisation \##{rec_id}", gap.abs, 'acheteuse', 'Acheteuse', 0, 0, now_str, created_by])
                INSERT INTO transactions (cash_day_id, cash_type, type, category, nature, object, amount, beneficiary_type, beneficiary_name, needs_justification, is_justified, created_at, created_by)
                VALUES (?, 'principale', 'sortie', 'regularisation', ?, ?, ?, 'acheteuse', 'Acheteuse', 0, 0, ?, ?)
              SQL
              final_tx_id = db.last_insert_row_id
            end
          end

          # Update reconciliation status to finalized
          db.execute("UPDATE reconciliations SET status = 'finalized', finalized_transaction_id = ? WHERE id = ?", [final_tx_id, rec_id])
        end

        send_json(res, 200, { success: true, message: "Régularisation finalisée. Écart de #{gap} enregistré.", finalized_transaction_id: final_tx_id })
      else
        send_error(res, 405, "Méthode non autorisée")
      end

    # ================= GENERAL DASHBOARD & SYNC =================
    when '/api/dashboard'
      # Fetch KPIs for RAF dashboard
      # 1. Caisse Principale details
      cp_day = db.get_first_row("SELECT * FROM cash_days WHERE cash_type = 'principale' ORDER BY id DESC LIMIT 1")
      cp_balance = 0.0
      cp_today_inflows = 0.0
      cp_today_outflows = 0.0
      cp_status = 'closed'
      cp_opened_by = nil
      cp_date = nil

      if cp_day
        cp_status = cp_day['status']
        cp_opened_by = cp_day['opened_by']
        cp_date = cp_day['date']
        
        # Calculate current balance
        bal_row = db.get_first_row(<<-SQL, [cp_day['id']])
          SELECT (cd.opening_balance + 
            COALESCE((SELECT SUM(amount) FROM transactions WHERE cash_day_id = cd.id AND type = 'entree'), 0) - 
            COALESCE((SELECT SUM(amount) FROM transactions WHERE cash_day_id = cd.id AND type = 'sortie'), 0)
          ) AS balance FROM cash_days cd WHERE cd.id = ?
        SQL
        cp_balance = bal_row['balance'].to_f
        
        # Today's sums
        in_row = db.get_first_row("SELECT SUM(amount) as sum FROM transactions WHERE cash_day_id = ? AND type = 'entree'", [cp_day['id']])
        cp_today_inflows = in_row['sum'].to_f
        
        out_row = db.get_first_row("SELECT SUM(amount) as sum FROM transactions WHERE cash_day_id = ? AND type = 'sortie'", [cp_day['id']])
        cp_today_outflows = out_row['sum'].to_f
      end

      # 2. Caisse d'Exploitation details
      ce_day = db.get_first_row("SELECT * FROM cash_days WHERE cash_type = 'exploitation' ORDER BY id DESC LIMIT 1")
      ce_balance = 0.0
      ce_today_inflows = 0.0
      ce_today_outflows = 0.0
      ce_status = 'closed'
      ce_opened_by = nil
      ce_date = nil

      if ce_day
        ce_status = ce_day['status']
        ce_opened_by = ce_day['opened_by']
        ce_date = ce_day['date']
        
        # Calculate current balance
        bal_row = db.get_first_row(<<-SQL, [ce_day['id']])
          SELECT (cd.opening_balance + 
            COALESCE((SELECT SUM(amount) FROM transactions WHERE cash_day_id = cd.id AND type = 'entree'), 0) - 
            COALESCE((SELECT SUM(amount) FROM transactions WHERE cash_day_id = cd.id AND type = 'sortie'), 0)
          ) AS balance FROM cash_days cd WHERE cd.id = ?
        SQL
        ce_balance = bal_row['balance'].to_f
        
        # Today's sums
        in_row = db.get_first_row("SELECT SUM(amount) as sum FROM transactions WHERE cash_day_id = ? AND type = 'entree'", [ce_day['id']])
        ce_today_inflows = in_row['sum'].to_f
        
        out_row = db.get_first_row("SELECT SUM(amount) as sum FROM transactions WHERE cash_day_id = ? AND type = 'sortie'", [ce_day['id']])
        ce_today_outflows = out_row['sum'].to_f
      end

      # 3. Unjustified receipts
      unjust_count = db.get_first_row("SELECT COUNT(*) as count FROM transactions WHERE needs_justification = 1 AND is_justified = 0")['count']
      unjust_sum = db.get_first_row("SELECT SUM(amount) as sum FROM transactions WHERE needs_justification = 1 AND is_justified = 0")['sum'].to_f

      # 4. Pending reconciliations
      pending_recs = db.get_first_row("SELECT COUNT(*) as count FROM reconciliations WHERE status = 'pending_raf'")['count']

      send_json(res, 200, {
        caisse_principale: {
          status: cp_status,
          date: cp_date,
          opened_by: cp_opened_by,
          balance: cp_balance,
          today_inflows: cp_today_inflows,
          today_outflows: cp_today_outflows
        },
        caisse_exploitation: {
          status: ce_status,
          date: ce_date,
          opened_by: ce_opened_by,
          balance: ce_balance,
          today_inflows: ce_today_inflows,
          today_outflows: ce_today_outflows
        },
        unjustified: {
          count: unjust_count,
          total_amount: unjust_sum
        },
        pending_reconciliations_count: pending_recs
      })

    when '/api/sync'
      # Light-weight sync state
      last_tx = db.get_first_row("SELECT MAX(id) as max_id FROM transactions")
      last_tx_id = last_tx ? last_tx['max_id'].to_i : 0

      last_day = db.get_first_row("SELECT MAX(id) as max_id FROM cash_days")
      last_day_id = last_day ? last_day['max_id'].to_i : 0

      pending_recs = db.get_first_row("SELECT COUNT(*) as count FROM reconciliations WHERE status = 'pending_raf'")['count']
      
      # Also get active open cash session statuses
      cp_day = db.get_first_row("SELECT status FROM cash_days WHERE cash_type = 'principale' ORDER BY id DESC LIMIT 1")
      ce_day = db.get_first_row("SELECT status FROM cash_days WHERE cash_type = 'exploitation' ORDER BY id DESC LIMIT 1")
      
      send_json(res, 200, {
        last_transaction_id: last_tx_id,
        last_cash_day_id: last_day_id,
        pending_reconciliations_count: pending_recs,
        cash_status: {
          principale: cp_day ? cp_day['status'] : 'closed',
          exploitation: ce_day ? ce_day['status'] : 'closed'
        }
      })

    else
      send_error(res, 404, "Endpoint API non trouvé")
    end

    db.close
  end
end

# WEBrick Server Configuration
port = 8000
server = WEBrick::HTTPServer.new(
  Port: port,
  DocumentRoot: File.join(File.dirname(__FILE__), 'public'),
  AccessLog: [], # Mute access logs to prevent polluting console
  Logger: WEBrick::Log.new(nil, WEBrick::BasicLog::WARN) # Minimize logging
)

# Mount API Servlet
server.mount '/api', APIServlet

# Detect local IP address for multi-workstation usage
local_ips = Socket.ip_address_list.select { |ip| ip.ipv4? && !ip.ipv4_loopback? }.map(&:ip_address)

puts "=========================================================="
puts "  GOLDEN CAISSE PRO - SERVEUR DE SYNC DEMARRÉ"
puts "=========================================================="
puts "  Accès local: http://localhost:#{port}"
if local_ips.empty?
  puts "  Accès réseau: Non connecté à un réseau local."
else
  local_ips.each do |ip|
    puts "  Accès réseau: http://#{ip}:#{port}"
  end
end
puts "  Appuyez sur Ctrl+C pour arrêter le serveur."
puts "=========================================================="

# Graceful Shutdown
trap('INT') { server.shutdown }

server.start
