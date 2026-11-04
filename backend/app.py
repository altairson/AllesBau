"""
AllesBau PWA Backend API
Python Flask REST API with SQLite database for PythonAnywhere deployment.
"""

import os
import sqlite3
import time
import uuid
import datetime
import functools
import hashlib
from flask import Flask, request, jsonify, g, send_from_directory
try:
    from flask_cors import CORS
    has_cors = True
except ImportError:
    has_cors = False

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if os.path.exists(os.path.join(BASE_DIR, 'index.html')):
    STATIC_DIR = BASE_DIR
else:
    STATIC_DIR = os.path.abspath(os.path.join(BASE_DIR, '..'))

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")

if has_cors:
    CORS(app)
else:
    @app.after_request
    def add_cors_headers(response):
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type,Authorization'
        response.headers['Access-Control-Allow-Methods'] = 'GET,PUT,POST,DELETE,OPTIONS'
        return response

    @app.before_request
    def handle_options():
        if request.method == 'OPTIONS':
            res = app.make_default_options_response()
            res.headers['Access-Control-Allow-Origin'] = '*'
            res.headers['Access-Control-Allow-Headers'] = 'Content-Type,Authorization'
            res.headers['Access-Control-Allow-Methods'] = 'GET,PUT,POST,DELETE,OPTIONS'
            return res

DB_FILE = os.path.join(BASE_DIR, "allesbau.db")
SECRET_KEY = os.environ.get("SECRET_KEY", "allesbau_secret_key_2026_super_secure")

# -------------------------------------------------------------------
# DATABASE HELPERS & INITIALIZATION
# -------------------------------------------------------------------

def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB_FILE)
        g.db.row_factory = sqlite3.Row
    return g.db

@app.teardown_appcontext
def close_db(exception):
    db = g.pop('db', None)
    if db is not None:
        db.close()

def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()

    # Crews Table
    c.execute('''
        CREATE TABLE IF NOT EXISTS crews (
            id TEXT PRIMARY KEY,
            company_name TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Users Table (Leader, Supervisor, Worker)
    c.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            crew_id TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            name TEXT NOT NULL,
            hourly_rate REAL DEFAULT 0.0,
            billing_rate REAL DEFAULT 0.0,
            phone TEXT,
            active INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (crew_id) REFERENCES crews (id)
        )
    ''')

    # Ensure billing_rate column exists in users table for existing databases
    c.execute("PRAGMA table_info(users)")
    user_cols = [col[1] for col in c.fetchall()]
    if 'billing_rate' not in user_cols:
        c.execute("ALTER TABLE users ADD COLUMN billing_rate REAL DEFAULT 0.0")
        c.execute("UPDATE users SET billing_rate = hourly_rate WHERE billing_rate = 0.0 OR billing_rate IS NULL")

    # Ensure media column exists in shifts table for existing databases
    c.execute("PRAGMA table_info(shifts)")
    shift_cols = [col[1] for col in c.fetchall()]
    if 'media' not in shift_cols:
        c.execute("ALTER TABLE shifts ADD COLUMN media TEXT DEFAULT ''")

    # Shifts Table
    c.execute('''
        CREATE TABLE IF NOT EXISTS shifts (
            id TEXT PRIMARY KEY,
            crew_id TEXT NOT NULL,
            worker_id TEXT NOT NULL,
            date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            break_minutes INTEGER DEFAULT 0,
            total_hours REAL NOT NULL,
            status TEXT DEFAULT 'pending',
            approved_by TEXT,
            note TEXT,
            updated_at INTEGER DEFAULT 0,
            FOREIGN KEY (crew_id) REFERENCES crews (id),
            FOREIGN KEY (worker_id) REFERENCES users (id)
        )
    ''')

    # Payments Table
    c.execute('''
        CREATE TABLE IF NOT EXISTS payments (
            id TEXT PRIMARY KEY,
            crew_id TEXT NOT NULL,
            worker_id TEXT NOT NULL,
            amount REAL NOT NULL,
            date TEXT NOT NULL,
            received_by TEXT,
            logged_by TEXT,
            comment TEXT,
            status TEXT DEFAULT 'pending',
            updated_at INTEGER DEFAULT 0,
            FOREIGN KEY (crew_id) REFERENCES crews (id),
            FOREIGN KEY (worker_id) REFERENCES users (id)
        )
    ''')

    # Active Timers Table
    c.execute('''
        CREATE TABLE IF NOT EXISTS timers (
            worker_id TEXT PRIMARY KEY,
            crew_id TEXT NOT NULL,
            start_time INTEGER,
            paused_accumulated INTEGER DEFAULT 0,
            pause_started_at INTEGER,
            status TEXT DEFAULT 'running',
            updated_at INTEGER DEFAULT 0,
            FOREIGN KEY (crew_id) REFERENCES crews (id),
            FOREIGN KEY (worker_id) REFERENCES users (id)
        )
    ''')

    conn.commit()
    conn.close()

# Password Hashing Helper
def hash_password(password):
    return hashlib.sha256((password + SECRET_KEY).encode('utf-8')).hexdigest()

def check_password(password, hashed):
    return hash_password(password) == hashed

# 30-minute interval time rounding helper
# Rule: if minutes > 15 and <= 45 -> 30 mins
#       else (<= 15 or > 45) -> 00 mins (hour increments if > 45)
# Examples: 8:14 -> 8:00, 8:16 -> 8:30, 8:45 -> 8:30, 8:46 -> 9:00
def round_time_to_30_minutes(time_str):
    if not time_str or ':' not in str(time_str):
        return time_str or '08:00'
    try:
        parts = str(time_str).strip().split(':')
        hours = int(parts[0])
        minutes = int(parts[1])
        if 15 < minutes <= 45:
            rounded_minutes = 30
            rounded_hours = hours
        else:
            rounded_minutes = 0
            if minutes > 45:
                rounded_hours = (hours + 1) % 24
            else:
                rounded_hours = hours
        return f"{rounded_hours:02d}:{rounded_minutes:02d}"
    except Exception:
        return time_str

def calculate_shift_hours(start_time_str, end_time_str, break_minutes=0):
    try:
        s_parts = round_time_to_30_minutes(start_time_str).split(':')
        e_parts = round_time_to_30_minutes(end_time_str).split(':')
        s_min = int(s_parts[0]) * 60 + int(s_parts[1])
        e_min = int(e_parts[0]) * 60 + int(e_parts[1])
        if e_min < s_min:
            e_min += 24 * 60
        worked_min = max(0, e_min - s_min - int(break_minutes or 0))
        return round(worked_min / 60.0, 2)
    except Exception:
        return 0.0

# Simple Token Helper for Auth
def generate_token(user_id, crew_id, role):
    payload = f"{user_id}:{crew_id}:{role}:{int(time.time())}"
    token_sig = hashlib.sha256((payload + SECRET_KEY).encode('utf-8')).hexdigest()
    return f"{payload}:{token_sig}"

def verify_token(token):
    if not token:
        return None
    try:
        parts = token.split(':')
        if len(parts) != 5:
            return None
        user_id, crew_id, role, timestamp, sig = parts
        expected_sig = hashlib.sha256((f"{user_id}:{crew_id}:{role}:{timestamp}" + SECRET_KEY).encode('utf-8')).hexdigest()
        if sig != expected_sig:
            return None
        return {"user_id": user_id, "crew_id": crew_id, "role": role}
    except Exception:
        return None

def login_required(f):
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization")
        token = None
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header.split(" ")[1]
        
        user_info = verify_token(token)
        if not user_info:
            return jsonify({"error": "Unauthorized / Invalid token"}), 401
        
        g.user = user_info
        return f(*args, **kwargs)
    return decorated

# Initialize DB structure on startup
init_db()

# -------------------------------------------------------------------
# AUTHENTICATION ENDPOINTS
# -------------------------------------------------------------------

@app.route('/api/auth/register-leader', methods=['POST'])
def register_leader():
    data = request.json or {}
    company_name = data.get('company_name', '').strip()
    leader_name = data.get('leader_name', '').strip()
    username = data.get('username', '').strip().lower()
    password = data.get('password', '').strip()

    if not company_name or not leader_name or not username or not password:
        return jsonify({"error": "All fields are required"}), 400

    db = get_db()
    existing = db.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    if existing:
        return jsonify({"error": "Username already taken"}), 400

    crew_id = "c_" + uuid.uuid4().hex[:10]
    user_id = "u_" + uuid.uuid4().hex[:10]
    pwd_hash = hash_password(password)

    db.execute("INSERT INTO crews (id, company_name) VALUES (?, ?)", (crew_id, company_name))
    db.execute("""
        INSERT INTO users (id, crew_id, username, password_hash, role, name)
        VALUES (?, ?, ?, ?, 'leader', ?)
    """, (user_id, crew_id, username, pwd_hash, leader_name))
    db.commit()

    token = generate_token(user_id, crew_id, 'leader')
    return jsonify({
        "message": "Crew registered successfully",
        "token": token,
        "user": {
            "id": user_id,
            "crew_id": crew_id,
            "username": username,
            "role": "leader",
            "name": leader_name,
            "company_name": company_name
        }
    }), 201

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json or {}
    username = data.get('username', '').strip().lower()
    password = data.get('password', '').strip()

    if not username or not password:
        return jsonify({"error": "Username and password required"}), 400

    db = get_db()
    user = db.execute("""
        SELECT u.*, c.company_name 
        FROM users u 
        JOIN crews c ON u.crew_id = c.id 
        WHERE LOWER(u.username) = ? AND u.active = 1
    """, (username,)).fetchone()

    if not user or not check_password(password, user['password_hash']):
        return jsonify({"error": "Invalid username or password"}), 401

    token = generate_token(user['id'], user['crew_id'], user['role'])
    
    # Calculate role-appropriate rate exposure
    h_rate = user['hourly_rate'] if 'hourly_rate' in user.keys() and user['hourly_rate'] is not None else 0.0
    b_rate = user['billing_rate'] if 'billing_rate' in user.keys() and user['billing_rate'] is not None else h_rate

    user_payload = {
        "id": user['id'],
        "crew_id": user['crew_id'],
        "username": user['username'],
        "role": user['role'],
        "name": user['name'],
        "company_name": user['company_name']
    }

    if user['role'] == 'leader':
        user_payload['hourly_rate'] = h_rate
        user_payload['billing_rate'] = b_rate
    elif user['role'] == 'supervisor':
        # Supervisor only sees what they pay
        user_payload['hourly_rate'] = b_rate
        user_payload['billing_rate'] = b_rate
    else:  # worker
        # Worker only sees their salary
        user_payload['hourly_rate'] = h_rate

    return jsonify({
        "token": token,
        "user": user_payload
    })

@app.route('/api/auth/change-password', methods=['POST'])
@login_required
def change_password():
    data = request.json or {}
    current_password = data.get('current_password', '')
    new_password = data.get('new_password', '')

    if not current_password or not new_password:
        return jsonify({"error": "Current and new password required"}), 400

    db = get_db()
    user = db.execute("SELECT * FROM users WHERE id = ?", (g.user['user_id'],)).fetchone()
    if not user or not check_password(current_password, user['password_hash']):
        return jsonify({"error": "Current password incorrect"}), 400

    new_hash = hash_password(new_password)
    db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (new_hash, g.user['user_id']))
    db.commit()
    return jsonify({"message": "Password changed successfully"})

# -------------------------------------------------------------------
# USER MANAGEMENT (LEADER ONLY)
# -------------------------------------------------------------------

@app.route('/api/users', methods=['GET'])
@login_required
def get_users():
    db = get_db()
    role = g.user['role']
    rows = db.execute("""
        SELECT id, username, role, name, hourly_rate, billing_rate, phone, active, created_at
        FROM users WHERE crew_id = ? AND active = 1 ORDER BY role DESC, name ASC
    """, (g.user['crew_id'],)).fetchall()
    
    result = []
    for r in rows:
        u = dict(r)
        h_rate = u.get('hourly_rate') or 0.0
        b_rate = u.get('billing_rate') if (u.get('billing_rate') is not None and u.get('billing_rate') > 0) else h_rate
        u['billing_rate'] = b_rate

        if role == 'leader':
            result.append(u)
        elif role == 'supervisor':
            # Supervisor only sees what he pays
            u['hourly_rate'] = b_rate
            u['billing_rate'] = b_rate
            result.append(u)
        else: # worker
            u.pop('billing_rate', None)
            result.append(u)
    return jsonify(result)

@app.route('/api/users/add-supervisor', methods=['POST'])
@login_required
def add_supervisor():
    if g.user['role'] != 'leader':
        return jsonify({"error": "Only leaders can add supervisors"}), 403

    data = request.json or {}
    name = data.get('name', '').strip()
    username = data.get('username', '').strip().lower()
    password = data.get('password', '').strip()

    if not name or not username or not password:
        return jsonify({"error": "Name, username, and initial password required"}), 400

    db = get_db()
    if db.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone():
        return jsonify({"error": "Username already taken"}), 400

    user_id = "u_" + uuid.uuid4().hex[:10]
    db.execute("""
        INSERT INTO users (id, crew_id, username, password_hash, role, name)
        VALUES (?, ?, ?, ?, 'supervisor', ?)
    """, (user_id, g.user['crew_id'], username, hash_password(password), name))
    db.commit()
    return jsonify({"message": f"Supervisor {name} added", "user_id": user_id}), 201

@app.route('/api/users/add-worker', methods=['POST'])
@login_required
def add_worker():
    if g.user['role'] != 'leader':
        return jsonify({"error": "Only leaders can add workers"}), 403

    data = request.json or {}
    name = data.get('name', '').strip()
    rate = float(data.get('hourly_rate', 20.0)) # Worker salary
    billing_rate = float(data.get('billing_rate', rate)) # Supervisor billing rate
    phone = data.get('phone', '').strip()
    username = data.get('username', '').strip().lower()
    password = data.get('password', '').strip()

    if not name or not username or not password:
        return jsonify({"error": "Worker name, login username, and password required"}), 400

    db = get_db()
    if db.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone():
        return jsonify({"error": "Username already taken"}), 400

    user_id = "w_" + uuid.uuid4().hex[:10]
    db.execute("""
        INSERT INTO users (id, crew_id, username, password_hash, role, name, hourly_rate, billing_rate, phone)
        VALUES (?, ?, ?, ?, 'worker', ?, ?, ?, ?)
    """, (user_id, g.user['crew_id'], username, hash_password(password), name, rate, billing_rate, phone))
    db.commit()
    return jsonify({
        "message": f"Worker {name} added",
        "user_id": user_id,
        "worker": {
            "id": user_id,
            "name": name,
            "username": username,
            "hourly_rate": rate,
            "billing_rate": billing_rate,
            "phone": phone
        }
    }), 201

@app.route('/api/users/<user_id>/rates', methods=['PUT', 'POST'])
@login_required
def update_worker_rates(user_id):
    if g.user['role'] != 'leader':
        return jsonify({"error": "Only leaders can change worker rates"}), 403

    data = request.json or {}
    db = get_db()
    worker = db.execute("SELECT * FROM users WHERE id = ? AND crew_id = ? AND role = 'worker'", 
                        (user_id, g.user['crew_id'])).fetchone()
    if not worker:
        return jsonify({"error": "Worker not found"}), 404

    hourly_rate = float(data.get('hourly_rate', worker['hourly_rate']))
    default_billing = worker['billing_rate'] if 'billing_rate' in worker.keys() and worker['billing_rate'] else hourly_rate
    billing_rate = float(data.get('billing_rate', default_billing))
    name = data.get('name')
    phone = data.get('phone')

    if name and name.strip():
        db.execute("UPDATE users SET name = ? WHERE id = ?", (name.strip(), user_id))
    if phone is not None:
        db.execute("UPDATE users SET phone = ? WHERE id = ?", (phone.strip(), user_id))

    db.execute("""
        UPDATE users SET hourly_rate = ?, billing_rate = ?
        WHERE id = ? AND crew_id = ?
    """, (hourly_rate, billing_rate, user_id, g.user['crew_id']))
    db.commit()

    return jsonify({
        "success": True,
        "message": f"Raten für {worker['name']} erfolgreich aktualisiert!",
        "worker": {
            "id": user_id,
            "hourly_rate": hourly_rate,
            "billing_rate": billing_rate
        }
    })

# -------------------------------------------------------------------
# FULL DATA SYNC ENDPOINT FOR MULTI-DEVICE LIVE CONNECTION
# -------------------------------------------------------------------

@app.route('/api/sync', methods=['GET'])
@login_required
def sync_crew_data():
    db = get_db()
    crew_id = g.user['crew_id']
    role = g.user['role']

    # Fetch users with role-specific rate projection
    rows = db.execute("""
        SELECT id, username, role, name, hourly_rate, billing_rate, phone, active
        FROM users WHERE crew_id = ? AND active = 1
    """, (crew_id,)).fetchall()

    users = []
    for r in rows:
        u = dict(r)
        h_rate = u.get('hourly_rate') or 0.0
        b_rate = u.get('billing_rate') if (u.get('billing_rate') is not None and u.get('billing_rate') > 0) else h_rate
        u['billing_rate'] = b_rate

        if role == 'leader':
            # Leader sees both: supervisor billing rate & worker salary (cut)
            users.append(u)
        elif role == 'supervisor':
            # Supervisor sees ONLY what he is paying
            u['hourly_rate'] = b_rate
            u['billing_rate'] = b_rate
            users.append(u)
        else:  # worker
            # Worker sees ONLY their salary
            u.pop('billing_rate', None)
            users.append(u)

    # Fetch shifts
    shifts = [dict(r) for r in db.execute("""
        SELECT id, worker_id as workerId, date, start_time as startTime, end_time as endTime, 
               break_minutes as breakMinutes, total_hours as totalHours, status, approved_by as approvedBy, note, media
        FROM shifts WHERE crew_id = ? ORDER BY date DESC, id DESC
    """, (crew_id,)).fetchall()]

    # Fetch payments
    payments = [dict(r) for r in db.execute("""
        SELECT id, worker_id as workerId, amount, date, received_by as receivedBy, 
               logged_by as loggedBy, comment, status
        FROM payments WHERE crew_id = ? ORDER BY date DESC, id DESC
    """, (crew_id,)).fetchall()]

    # Fetch timers
    timers_rows = db.execute("""
        SELECT worker_id, start_time, paused_accumulated, pause_started_at, status
        FROM timers WHERE crew_id = ?
    """, (crew_id,)).fetchall()
    
    timers = {}
    for r in timers_rows:
        timers[r['worker_id']] = {
            "startTime": r['start_time'],
            "pausedAccumulated": r['paused_accumulated'],
            "pauseStartedAt": r['pause_started_at'],
            "status": r['status']
        }

    return jsonify({
        "timestamp": int(time.time() * 1000),
        "workers": users,
        "shifts": shifts,
        "payments": payments,
        "timers": timers
    })

# -------------------------------------------------------------------
# TIMERS, SHIFTS & PAYMENTS MUTATIONS
# -------------------------------------------------------------------

@app.route('/api/timers/start', methods=['POST'])
@login_required
def start_timer():
    if g.user['role'] != 'leader':
        return jsonify({"error": "Only leader can start timers"}), 403
    
    worker_id = request.json.get('worker_id')
    now = int(time.time() * 1000)
    
    db = get_db()
    db.execute("""
        INSERT OR REPLACE INTO timers (worker_id, crew_id, start_time, paused_accumulated, pause_started_at, status, updated_at)
        VALUES (?, ?, ?, 0, NULL, 'running', ?)
    """, (worker_id, g.user['crew_id'], now, int(time.time())))
    db.commit()
    return jsonify({"success": True})

@app.route('/api/timers/pause', methods=['POST'])
@login_required
def pause_timer():
    if g.user['role'] != 'leader':
        return jsonify({"error": "Only leader can pause timers"}), 403

    worker_id = request.json.get('worker_id')
    db = get_db()
    timer = db.execute("SELECT * FROM timers WHERE worker_id = ?", (worker_id,)).fetchone()
    if not timer:
        return jsonify({"error": "Timer not found"}), 404

    now = int(time.time() * 1000)
    if timer['status'] == 'running':
        accumulated = (timer['paused_accumulated'] or 0) + int((now - timer['start_time']) / 1000)
        db.execute("""
            UPDATE timers SET paused_accumulated = ?, pause_started_at = ?, status = 'paused', start_time = NULL, updated_at = ?
            WHERE worker_id = ?
        """, (accumulated, now, int(time.time()), worker_id))
    else:
        db.execute("""
            UPDATE timers SET start_time = ?, pause_started_at = NULL, status = 'running', updated_at = ?
            WHERE worker_id = ?
        """, (now, int(time.time()), worker_id))

    db.commit()
    return jsonify({"success": True})

@app.route('/api/timers/stop', methods=['POST'])
@login_required
def stop_timer():
    data = request.json or {}
    worker_id = data.get('worker_id')
    if not worker_id:
        return jsonify({"error": "Worker ID fehlt"}), 400

    # Allow worker to stop their own timer, or leader/supervisor to stop any crew timer
    if g.user['role'] not in ['leader', 'supervisor'] and g.user['id'] != worker_id:
        return jsonify({"error": "Keine Berechtigung zum Stoppen dieses Timers"}), 403

    date_str = data.get('date') or datetime.now().strftime('%Y-%m-%d')
    round_time = data.get('round_time', True)
    if round_time:
        start_time_str = round_time_to_30_minutes(data.get('start_time'))
        end_time_str = round_time_to_30_minutes(data.get('end_time'))
    else:
        start_time_str = str(data.get('start_time', '08:00')).strip()
        end_time_str = str(data.get('end_time', '17:00')).strip()

    break_mins = int(data.get('break_minutes', 0))
    total_hours = float(data.get('total_hours', 0.0)) or calculate_shift_hours(start_time_str, end_time_str, break_mins)
    note = data.get('note', 'Schicht über Live-Timer erfasst')
    
    # Properly serialize media array to JSON string for SQLite storage
    raw_media = data.get('media', '')
    if isinstance(raw_media, (list, dict)):
        media = json.dumps(raw_media)
    else:
        media = str(raw_media or '')

    db = get_db()
    # Double entry prevention
    dup = db.execute("""
        SELECT id FROM shifts 
        WHERE crew_id = ? AND worker_id = ? AND date = ? AND start_time = ? AND end_time = ?
    """, (g.user['crew_id'], worker_id, date_str, start_time_str, end_time_str)).fetchone()
    if dup:
        return jsonify({"error": "Doppelte Schicht: Für diesen Arbeiter existiert bereits eine Schicht zu dieser Zeit."}), 400

    shift_id = "s_" + uuid.uuid4().hex[:10]
    db.execute("""
        INSERT INTO shifts (id, crew_id, worker_id, date, start_time, end_time, break_minutes, total_hours, status, note, media, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    """, (shift_id, g.user['crew_id'], worker_id, date_str, start_time_str, end_time_str, break_mins, total_hours, note, media, int(time.time())))
    
    db.execute("DELETE FROM timers WHERE worker_id = ?", (worker_id,))
    db.commit()
    return jsonify({"success": True, "shift_id": shift_id})

@app.route('/api/shifts/manual', methods=['POST'])
@login_required
def add_manual_shift():
    data = request.json or {}
    worker_ids = data.get('worker_ids') or ([data.get('worker_id')] if data.get('worker_id') else [])
    date_str = data.get('date') or datetime.now().strftime('%Y-%m-%d')
    round_time = data.get('round_time', True)
    if round_time:
        start_time = round_time_to_30_minutes(data.get('start_time'))
        end_time = round_time_to_30_minutes(data.get('end_time'))
    else:
        start_time = str(data.get('start_time', '08:00')).strip()
        end_time = str(data.get('end_time', '16:30')).strip()

    break_mins = int(data.get('break_minutes', 0))
    total_hours = float(data.get('total_hours', 0.0)) or calculate_shift_hours(start_time, end_time, break_mins)
    note = data.get('note', '')

    raw_media = data.get('media', '')
    if isinstance(raw_media, (list, dict)):
        media = json.dumps(raw_media)
    else:
        media = str(raw_media or '')

    db = get_db()
    shift_ids = []
    for worker_id in worker_ids:
        # Check duplicate
        dup = db.execute("""
            SELECT id FROM shifts 
            WHERE crew_id = ? AND worker_id = ? AND date = ? AND start_time = ? AND end_time = ?
        """, (g.user['crew_id'], worker_id, date_str, start_time, end_time)).fetchone()
        if dup:
            continue

        shift_id = "s_" + uuid.uuid4().hex[:10]
        db.execute("""
            INSERT INTO shifts (id, crew_id, worker_id, date, start_time, end_time, break_minutes, total_hours, status, note, media, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        """, (shift_id, g.user['crew_id'], worker_id, date_str, start_time, end_time, break_mins, total_hours, note, media, int(time.time())))
        shift_ids.append(shift_id)

    db.commit()
    if not shift_ids:
        return jsonify({"error": "Für alle gewählten Mitarbeiter existieren bereits Schichten zu dieser Zeit."}), 400
    return jsonify({"success": True, "shift_ids": shift_ids, "shift_id": shift_ids[0]})

@app.route('/api/shifts/<shift_id>', methods=['PUT'])
@login_required
def edit_shift(shift_id):
    if g.user['role'] != 'leader':
        return jsonify({"error": "Only leaders can edit shifts"}), 403

    data = request.json or {}
    worker_id = data.get('worker_id') or data.get('workerId')
    date_str = data.get('date')
    start_time = data.get('start_time') or data.get('startTime')
    end_time = data.get('end_time') or data.get('endTime')
    break_mins = int(data.get('break_minutes', data.get('breakMinutes', 0)))
    total_hours = float(data.get('total_hours', data.get('totalHours', 0.0))) or calculate_shift_hours(start_time, end_time, break_mins)
    note = data.get('note', '')
    
    raw_media = data.get('media', '')
    if isinstance(raw_media, (list, dict)):
        media = json.dumps(raw_media)
    else:
        media = str(raw_media or '')

    status = data.get('status', 'pending')

    db = get_db()
    db.execute("""
        UPDATE shifts 
        SET worker_id = ?, date = ?, start_time = ?, end_time = ?, break_minutes = ?, 
            total_hours = ?, note = ?, media = ?, status = ?, updated_at = ?
        WHERE id = ? AND crew_id = ?
    """, (worker_id, date_str, start_time, end_time, break_mins, total_hours, note, media, status, int(time.time()), shift_id, g.user['crew_id']))
    db.commit()
    return jsonify({"success": True})

@app.route('/api/shifts/<shift_id>', methods=['DELETE'])
@login_required
def delete_shift(shift_id):
    if g.user['role'] != 'leader':
        return jsonify({"error": "Only leaders can delete shifts"}), 403

    db = get_db()
    db.execute("DELETE FROM shifts WHERE id = ? AND crew_id = ?", (shift_id, g.user['crew_id']))
    db.commit()
    return jsonify({"success": True})

@app.route('/api/shifts/<shift_id>/status', methods=['PUT'])
@login_required
def update_shift_status(shift_id):
    if g.user['role'] not in ['supervisor', 'leader']:
        return jsonify({"error": "Only supervisors or leaders can update shift status"}), 403

    status = request.json.get('status')
    if status not in ['approved', 'rejected']:
        return jsonify({"error": "Invalid status"}), 400

    approver = 'Supervisor' if g.user['role'] == 'supervisor' else 'Leader'
    db = get_db()
    db.execute("""
        UPDATE shifts SET status = ?, approved_by = ?, updated_at = ?
        WHERE id = ? AND crew_id = ?
    """, (status, approver, int(time.time()), shift_id, g.user['crew_id']))
    db.commit()
    return jsonify({"success": True})

@app.route('/api/shifts/approve-all', methods=['POST'])
@login_required
def approve_all_shifts():
    if g.user['role'] not in ['supervisor', 'leader']:
        return jsonify({"error": "Only supervisors or leaders can approve shifts"}), 403

    approver = 'Supervisor' if g.user['role'] == 'supervisor' else 'Leader'
    db = get_db()
    db.execute("""
        UPDATE shifts SET status = 'approved', approved_by = ?, updated_at = ?
        WHERE crew_id = ? AND status = 'pending'
    """, (approver, int(time.time()), g.user['crew_id']))
    db.commit()
    return jsonify({"success": True})

@app.route('/api/payments', methods=['POST'])
@login_required
def log_payment():
    data = request.json or {}
    worker_id = data.get('worker_id') or data.get('workerId')
    amount = float(data.get('amount', 0.0))
    date_str = data.get('date')
    received_by = data.get('received_by') or data.get('receivedBy', '')
    comment = data.get('comment', '')
    status = data.get('status', 'pending')

    if amount <= 0:
        return jsonify({"error": "Betrag muss größer als 0 sein."}), 400

    db = get_db()
    # Double payment check
    dup = db.execute("""
        SELECT id FROM payments 
        WHERE crew_id = ? AND worker_id = ? AND date = ? AND amount = ? AND status = 'pending'
    """, (g.user['crew_id'], worker_id, date_str, amount)).fetchone()
    if dup:
        return jsonify({"error": "Eine ausstehende Zahlung mit demselben Betrag existiert bereits für diesen Arbeiter an diesem Tag."}), 400

    payment_id = "p_" + uuid.uuid4().hex[:10]
    db.execute("""
        INSERT INTO payments (id, crew_id, worker_id, amount, date, received_by, logged_by, comment, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (payment_id, g.user['crew_id'], worker_id, amount, date_str, received_by, g.user['role'].capitalize(), comment, status, int(time.time())))
    db.commit()
    return jsonify({"success": True, "payment_id": payment_id})

@app.route('/api/payments/<payment_id>/status', methods=['PUT'])
@login_required
def update_payment_status(payment_id):
    if g.user['role'] not in ['supervisor', 'leader']:
        return jsonify({"error": "Only supervisors or leaders can approve or reject payments"}), 403

    status = request.json.get('status')
    if status not in ['approved', 'rejected']:
        return jsonify({"error": "Invalid status"}), 400

    db = get_db()
    db.execute("""
        UPDATE payments SET status = ?, updated_at = ?
        WHERE id = ? AND crew_id = ?
    """, (status, int(time.time()), payment_id, g.user['crew_id']))
    db.commit()
    return jsonify({"success": True})

# Serve static PWA files
@app.route('/')
def serve_index():
    return send_from_directory(STATIC_DIR, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    target_file = os.path.join(STATIC_DIR, path)
    if os.path.exists(target_file) and os.path.isfile(target_file):
        return send_from_directory(STATIC_DIR, path)
    return send_from_directory(STATIC_DIR, 'index.html')

if __name__ == '__main__':
    print("🚀 AllesBau Backend Running on http://localhost:5000")
    app.run(host='0.0.0.0', port=5000, debug=True)
