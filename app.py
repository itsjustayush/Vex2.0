import os
import json
import secrets
import datetime
import hmac
import hashlib
import base64
from functools import wraps
from flask import Flask, request, jsonify, render_template
from dotenv import load_dotenv
import requests

load_dotenv()

app = Flask(__name__, template_folder='templates')

# Secret Key for signing Developer JWT Tokens
API_SECRET_KEY = os.getenv("API_SECRET_KEY", "vex-super-secret-jwt-key-change-in-prod")

def _base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('utf-8')

def _base64url_decode(s: str) -> bytes:
    padding = '=' * (4 - (len(s) % 4))
    return base64.urlsafe_b64decode(s + padding)

def encode_jwt_token(payload: dict, secret: str = API_SECRET_KEY) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    header_b64 = _base64url_encode(json.dumps(header, separators=(',', ':')).encode('utf-8'))
    payload_b64 = _base64url_encode(json.dumps(payload, separators=(',', ':')).encode('utf-8'))
    signing_input = f"{header_b64}.{payload_b64}"
    signature = hmac.new(secret.encode('utf-8'), signing_input.encode('utf-8'), hashlib.sha256).digest()
    sig_b64 = _base64url_encode(signature)
    return f"{signing_input}.{sig_b64}"

def decode_jwt_token(token: str, secret: str = API_SECRET_KEY) -> dict:
    parts = token.split('.')
    if len(parts) != 3:
        raise ValueError("Invalid JWT token format")
    header_b64, payload_b64, sig_b64 = parts
    signing_input = f"{header_b64}.{payload_b64}"
    expected_sig = hmac.new(secret.encode('utf-8'), signing_input.encode('utf-8'), hashlib.sha256).digest()
    actual_sig = _base64url_decode(sig_b64)
    if not hmac.compare_digest(expected_sig, actual_sig):
        raise ValueError("Invalid JWT signature")
    payload_json = _base64url_decode(payload_b64).decode('utf-8')
    return json.loads(payload_json)

# Load Firebase configuration from environment or config file
FIREBASE_CONFIG = {}
CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'firebase-applet-config.json')
if os.path.exists(CONFIG_FILE):
    try:
        with open(CONFIG_FILE, 'r') as f:
            FIREBASE_CONFIG = json.load(f)
    except Exception as e:
        print(f"Error loading firebase-applet-config.json: {e}")

# Fallback config
PROJECT_ID = FIREBASE_CONFIG.get("projectId") or os.getenv("FIREBASE_PROJECT_ID", "vex-app")
API_KEY = FIREBASE_CONFIG.get("apiKey") or os.getenv("FIREBASE_API_KEY", "")
AUTH_DOMAIN = FIREBASE_CONFIG.get("authDomain") or os.getenv("FIREBASE_AUTH_DOMAIN", f"{PROJECT_ID}.firebaseapp.com")
FIRESTORE_DATABASE_ID = FIREBASE_CONFIG.get("firestoreDatabaseId") or os.getenv("FIRESTORE_DATABASE_ID", "(default)")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

genai = None
try:
    import google.generativeai as genai
    if GEMINI_API_KEY:
        genai.configure(api_key=GEMINI_API_KEY)
except Exception as e:
    print(f"google.generativeai SDK setup notice: {e}")

# Firebase Admin SDK setup
firebase_admin_initialized = False
db = None

try:
    import firebase_admin
    from firebase_admin import credentials, auth, firestore

    if not firebase_admin._apps:
        cred_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_KEY")
        if cred_json:
            try:
                cred_dict = json.loads(cred_json)
                cred = credentials.Certificate(cred_dict)
                firebase_admin.initialize_app(cred, {'projectId': PROJECT_ID})
                firebase_admin_initialized = True
            except Exception as e:
                print(f"Error initializing Firebase Admin with service account: {e}")
        
        if not firebase_admin_initialized:
            try:
                # Initialize with default application credentials or project ID
                firebase_admin.initialize_app(options={'projectId': PROJECT_ID})
                firebase_admin_initialized = True
            except Exception as e:
                print(f"Firebase default app init skipped: {e}")

    if firebase_admin_initialized:
        try:
            if FIRESTORE_DATABASE_ID and FIRESTORE_DATABASE_ID != "(default)":
                db = firestore.client(database=FIRESTORE_DATABASE_ID)
            else:
                db = firestore.client()
        except Exception as e:
            print(f"Firestore client init error: {e}")
            db = None
except Exception as e:
    print(f"Firebase Admin SDK import error: {e}")

# In-Memory Storage Fallback if Firestore is not connected
IN_MEMORY_PROJECTS = [
    {
        "id": "prj_demo123456",
        "user_id": "demo_user",
        "title": "Personal Workspace",
        "description": "Main research and networked ideas workspace.",
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }
]

IN_MEMORY_FILES = [
    {
        "id": "nt_demo101",
        "user_id": "demo_user",
        "project_id": "prj_demo123456",
        "title": "Welcome to Vex",
        "content": "# Welcome to Vex 🚀\n\nVex is your networked thought platform.\n\n### Key Features:\n- **Markdown & LaTeX**: Support for equations like $E = mc^2$ and math blocks:\n  $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$\n- **Networked Notes**: Organize by folders and tags.\n- **Vex AI**: Powered by Gemini 2.5 Flash for instant brainstorming.",
        "folder": "General",
        "extension": "md",
        "is_public": True,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }
]

IN_MEMORY_KEYS = [
    {
        "id": "key_demo001",
        "user_id": "demo_user",
        "name": "Default Production Key",
        "key": f"vex_live_{secrets.token_hex(16)}",
        "is_active": True,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }
]

IN_MEMORY_VERSIONS = []


# ==========================================
# CORS & PREFLIGHT SUPPORT
# ==========================================
@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        res = jsonify({"status": "ok"})
        res.headers['Access-Control-Allow-Origin'] = '*'
        res.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-API-Key'
        res.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
        return res, 200

@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-API-Key'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    return response


# ==========================================
# AUTHENTICATION DECORATOR (ID Token OR Developer JWT API Key)
# ==========================================
def require_auth(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # 1. Check for API Key in headers or query params
        api_key = request.headers.get("X-API-Key", "").strip()
        auth_header = request.headers.get("Authorization", "").strip()

        if not api_key and auth_header.startswith("vex_live_"):
            api_key = auth_header
        elif not api_key and auth_header.startswith("Bearer vex_live_"):
            api_key = auth_header[7:].strip()
        elif not api_key:
            api_key = request.args.get("api_key") or request.args.get("key") or ""

        if api_key:
            # Validate developer API key
            key_user = None
            if db:
                try:
                    docs = db.collection("api_keys").where("key", "==", api_key).where("is_active", "==", True).stream()
                    for d in docs:
                        key_user = d.to_dict().get("user_id") or d.to_dict().get("uid")
                        break
                except Exception as e:
                    print(f"Error checking API key in Firestore: {e}")

            if not key_user:
                matched_key = next((k for k in IN_MEMORY_KEYS if (k.get("key") == api_key or k.get("token") == api_key) and k.get("is_active", True)), None)
                if matched_key:
                    key_user = matched_key.get("user_id") or matched_key.get("uid")

            if key_user:
                request.user_id = key_user
                request.uid = key_user
                return f(*args, **kwargs)
            else:
                return jsonify({"detail": "Unauthorized: Invalid Developer API Key"}), 401

        # 2. Check for Bearer token (Firebase ID Token OR Developer JWT Token)
        token = None
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()

        if not token:
            token = request.args.get("token") or ""

        request_uid = None

        # Attempt A: Check if it's a Firebase ID Token
        if token and token != "demo-token" and firebase_admin_initialized:
            try:
                from firebase_admin import auth as fb_auth
                decoded_token = fb_auth.verify_id_token(token)
                request_uid = decoded_token.get("uid")
            except Exception:
                pass # Not a valid Firebase token, move to Attempt B

        # Attempt B: Check if it's a Developer JWT Token
        if not request_uid and token and token != "demo-token":
            try:
                jwt_payload = decode_jwt_token(token)
                key_id = jwt_payload.get("key_id")
                payload_uid = jwt_payload.get("uid")

                key_active = False
                if db and key_id:
                    try:
                        doc = db.collection("api_keys").document(key_id).get()
                        if doc.exists and doc.to_dict().get("is_active", True):
                            key_active = True
                    except Exception as e:
                        print(f"Error validating JWT key in Firestore: {e}")
                else:
                    matched = next((k for k in IN_MEMORY_KEYS if k.get("id") == key_id and k.get("is_active", True)), None)
                    if matched or not key_id:
                        key_active = True

                if key_active and payload_uid:
                    request_uid = payload_uid
            except Exception:
                pass

        if not request_uid:
            if token == "demo-token" or not token:
                request_uid = "demo_user"
            else:
                return jsonify({"detail": "Unauthorized: Invalid or expired token"}), 401

        request.user_id = request_uid
        request.uid = request_uid
        return f(*args, **kwargs)
    return decorated_function


def save_version_snapshot(note_id, title, content, user_id):
    now_str = datetime.datetime.now(datetime.timezone.utc).isoformat()
    version_obj = {
        "id": f"v_{secrets.token_hex(4)}",
        "file_id": note_id,
        "title": title,
        "content": content,
        "user_id": user_id,
        "saved_at": now_str
    }
    if db:
        try:
            db.collection("files").document(note_id).collection("versions").document(version_obj["id"]).set(version_obj)
        except Exception as e:
            print(f"Error saving version in Firestore: {e}")
    
    IN_MEMORY_VERSIONS.insert(0, version_obj)
    return version_obj


# ==========================================
# PAGE ROUTE HELPERS & TEMPLATES
# ==========================================
def render_page(template_name):
    return render_template(
        template_name,
        firebase_config=FIREBASE_CONFIG,
        firebase_json=json.dumps(FIREBASE_CONFIG)
    )

@app.route("/")
def index():
    return render_page("index.html")

@app.route("/login")
def login():
    return render_page("login.html")

@app.route("/dashboard")
def dashboard():
    return render_page("dashboard.html")

@app.route("/settings")
def settings():
    return render_page("settings.html")

@app.route("/docs")
def docs():
    return render_page("docs.html")

@app.route("/status")
def status():
    return render_page("status.html")


# ==========================================
# API HEALTH & STATUS
# ==========================================
@app.get("/api/health")
def api_health():
    return jsonify({
        "status": "online",
        "firebase_admin_active": bool(firebase_admin_initialized and db),
        "gemini_configured": bool(GEMINI_API_KEY),
        "project_id": PROJECT_ID
    })


# ==========================================
# PROJECTS API
# ==========================================
@app.route("/api/v1/projects", methods=["GET", "POST"])
@require_auth
def projects_api():
    global IN_MEMORY_PROJECTS
    uid = getattr(request, 'user_id', 'demo_user')

    if request.method == "GET":
        if db:
            try:
                docs_ref = db.collection("projects").where("user_id", "==", uid).stream()
                projects_list = [d.to_dict() for d in docs_ref]
                projects_list.sort(key=lambda x: x.get("created_at", ""), reverse=True)
                return jsonify({"projects": projects_list})
            except Exception as e:
                print(f"Firestore GET projects failed: {e}")

        user_projects = [p for p in IN_MEMORY_PROJECTS if p["user_id"] == uid or uid == "demo_user"]
        return jsonify({"projects": user_projects})

    elif request.method == "POST":
        data = request.get_json() or {}
        new_proj = {
            "id": f"prj_{secrets.token_hex(6)}",
            "user_id": uid,
            "title": data.get("title", "Untitled").strip() or "Untitled",
            "description": data.get("description", "").strip(),
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }

        if db:
            try:
                db.collection("projects").document(new_proj["id"]).set(new_proj)
                return jsonify({"project": new_proj}), 201
            except Exception as e:
                print(f"Firestore POST project failed: {e}")

        IN_MEMORY_PROJECTS.insert(0, new_proj)
        return jsonify({"project": new_proj}), 201


@app.route("/api/v1/projects/<project_id>", methods=["DELETE"])
@require_auth
def delete_project_api(project_id):
    global IN_MEMORY_PROJECTS, IN_MEMORY_FILES
    uid = getattr(request, 'user_id', 'demo_user')

    if db:
        try:
            db.collection("projects").document(project_id).delete()
            # Delete associated files
            files_ref = db.collection("files").where("project_id", "==", project_id).stream()
            for doc in files_ref:
                doc.reference.delete()
        except Exception as e:
            print(f"Firestore DELETE project failed: {e}")

    IN_MEMORY_PROJECTS = [p for p in IN_MEMORY_PROJECTS if p["id"] != project_id]
    IN_MEMORY_FILES = [f for f in IN_MEMORY_FILES if f.get("project_id") != project_id]

    return jsonify({"status": "deleted"})


# ==========================================
# FILES / NOTES API
# ==========================================
@app.route("/api/v1/projects/<project_id>/files", methods=["GET", "POST"])
@require_auth
def project_files_api(project_id):
    global IN_MEMORY_FILES
    uid = getattr(request, 'user_id', 'demo_user')

    if request.method == "GET":
        if db:
            try:
                docs_ref = db.collection("files").where("project_id", "==", project_id).stream()
                files_list = [d.to_dict() for d in docs_ref]
                files_list.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
                return jsonify({"files": files_list})
            except Exception as e:
                print(f"Firestore GET files failed: {e}")

        files = [f for f in IN_MEMORY_FILES if f.get("project_id") == project_id]
        return jsonify({"files": files})

    elif request.method == "POST":
        data = request.get_json() or {}
        now_str = datetime.datetime.now(datetime.timezone.utc).isoformat()
        new_file = {
            "id": f"nt_{secrets.token_hex(6)}",
            "user_id": uid,
            "project_id": project_id,
            "title": data.get("title", "Untitled Note").strip() or "Untitled Note",
            "content": data.get("content", ""),
            "folder": data.get("folder", "General").strip() or "General",
            "extension": data.get("extension", "md"),
            "is_public": bool(data.get("is_public", False)),
            "created_at": now_str,
            "updated_at": now_str
        }

        if db:
            try:
                db.collection("files").document(new_file["id"]).set(new_file)
                return jsonify({"file": new_file}), 201
            except Exception as e:
                print(f"Firestore POST file failed: {e}")

        IN_MEMORY_FILES.insert(0, new_file)
        return jsonify({"file": new_file}), 201


@app.route("/api/v1/projects/<project_id>/files/<file_id>", methods=["PUT", "DELETE"])
@require_auth
def update_delete_file_api(project_id, file_id):
    global IN_MEMORY_FILES
    uid = getattr(request, 'user_id', 'demo_user')

    if request.method == "PUT":
        data = request.get_json() or {}
        now_str = datetime.datetime.now(datetime.timezone.utc).isoformat()

        patch_data = {"updated_at": now_str}
        for field in ["title", "content", "folder", "extension", "is_public"]:
            if field in data:
                patch_data[field] = data[field]

        if db:
            try:
                doc_ref = db.collection("files").document(file_id)
                doc_ref.update(patch_data)
                updated_doc = doc_ref.get()
                if updated_doc.exists:
                    doc_data = updated_doc.to_dict()
                    # Save version snapshot
                    save_version_snapshot(file_id, doc_data.get("title", "Untitled"), doc_data.get("content", ""), uid)
                    return jsonify({"file": doc_data})
            except Exception as e:
                print(f"Firestore PUT file failed: {e}")

        file_obj = next((f for f in IN_MEMORY_FILES if f["id"] == file_id and f.get("project_id") == project_id), None)
        if not file_obj:
            return jsonify({"detail": "File not found"}), 404

        for field in ["title", "content", "folder", "extension", "is_public"]:
            if field in data:
                file_obj[field] = data[field]
        file_obj["updated_at"] = now_str
        save_version_snapshot(file_id, file_obj.get("title", "Untitled"), file_obj.get("content", ""), uid)

        return jsonify({"file": file_obj})

    elif request.method == "DELETE":
        if db:
            try:
                db.collection("files").document(file_id).delete()
            except Exception as e:
                print(f"Firestore DELETE file failed: {e}")

        IN_MEMORY_FILES = [f for f in IN_MEMORY_FILES if not (f["id"] == file_id and f.get("project_id") == project_id)]
        return jsonify({"status": "deleted"})


# ==========================================
# DIRECT NOTES CRUD API (/api/v1/notes)
# ==========================================
@app.route("/api/v1/notes", methods=["GET", "POST"])
@require_auth
def notes_direct_api():
    global IN_MEMORY_FILES, IN_MEMORY_PROJECTS
    uid = getattr(request, 'user_id', 'demo_user')

    if request.method == "GET":
        project_id = request.args.get("project_id")
        q = request.args.get("q") or request.args.get("search") or ""

        files_list = []
        if db:
            try:
                if project_id:
                    docs_ref = db.collection("files").where("project_id", "==", project_id).stream()
                else:
                    docs_ref = db.collection("files").where("user_id", "==", uid).stream()
                files_list = [d.to_dict() for d in docs_ref]
            except Exception as e:
                print(f"Firestore GET notes error: {e}")

        if not files_list:
            if project_id:
                files_list = [f for f in IN_MEMORY_FILES if f.get("project_id") == project_id]
            else:
                files_list = [f for f in IN_MEMORY_FILES if f.get("user_id") == uid or uid == "demo_user"]

        if q:
            q_lower = q.lower()
            files_list = [
                f for f in files_list 
                if q_lower in f.get("title", "").lower() or q_lower in f.get("content", "").lower() or q_lower in f.get("folder", "").lower()
            ]

        files_list.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
        return jsonify({"notes": files_list, "count": len(files_list)})

    elif request.method == "POST":
        data = request.get_json() or {}
        now_str = datetime.datetime.now(datetime.timezone.utc).isoformat()
        
        project_id = data.get("project_id")
        if not project_id:
            # Find user's first project or create default
            user_projs = [p for p in IN_MEMORY_PROJECTS if p["user_id"] == uid or uid == "demo_user"]
            if user_projs:
                project_id = user_projs[0]["id"]
            else:
                project_id = "prj_demo123456"

        new_note = {
            "id": f"nt_{secrets.token_hex(6)}",
            "user_id": uid,
            "project_id": project_id,
            "title": data.get("title", "Untitled Note").strip() or "Untitled Note",
            "content": data.get("content", ""),
            "folder": data.get("folder", "General").strip() or "General",
            "extension": data.get("extension", "md"),
            "is_public": bool(data.get("is_public", False)),
            "created_at": now_str,
            "updated_at": now_str
        }

        if db:
            try:
                db.collection("files").document(new_note["id"]).set(new_note)
                save_version_snapshot(new_note["id"], new_note["title"], new_note["content"], uid)
                return jsonify({"note": new_note}), 201
            except Exception as e:
                print(f"Firestore POST note error: {e}")

        IN_MEMORY_FILES.insert(0, new_note)
        save_version_snapshot(new_note["id"], new_note["title"], new_note["content"], uid)
        return jsonify({"note": new_note}), 201


@app.route("/api/v1/notes/<note_id>", methods=["GET", "PUT", "DELETE"])
@require_auth
def note_detail_direct_api(note_id):
    global IN_MEMORY_FILES
    uid = getattr(request, 'user_id', 'demo_user')

    if request.method == "GET":
        if db:
            try:
                doc = db.collection("files").document(note_id).get()
                if doc.exists:
                    return jsonify({"note": doc.to_dict()})
            except Exception as e:
                print(f"Firestore GET note error: {e}")

        note = next((f for f in IN_MEMORY_FILES if f["id"] == note_id), None)
        if not note:
            return jsonify({"detail": "Note not found"}), 404
        return jsonify({"note": note})

    elif request.method == "PUT":
        data = request.get_json() or {}
        now_str = datetime.datetime.now(datetime.timezone.utc).isoformat()
        patch_data = {"updated_at": now_str}
        
        for field in ["title", "content", "folder", "extension", "is_public", "project_id"]:
            if field in data:
                patch_data[field] = data[field]

        if db:
            try:
                doc_ref = db.collection("files").document(note_id)
                doc_ref.update(patch_data)
                updated = doc_ref.get().to_dict()
                save_version_snapshot(note_id, updated.get("title", "Untitled"), updated.get("content", ""), uid)
                return jsonify({"note": updated})
            except Exception as e:
                print(f"Firestore PUT note error: {e}")

        note = next((f for f in IN_MEMORY_FILES if f["id"] == note_id), None)
        if not note:
            return jsonify({"detail": "Note not found"}), 404

        for field in ["title", "content", "folder", "extension", "is_public", "project_id"]:
            if field in data:
                note[field] = data[field]
        note["updated_at"] = now_str
        save_version_snapshot(note_id, note.get("title", "Untitled"), note.get("content", ""), uid)

        return jsonify({"note": note})

    elif request.method == "DELETE":
        if db:
            try:
                db.collection("files").document(note_id).delete()
            except Exception as e:
                print(f"Firestore DELETE note error: {e}")

        IN_MEMORY_FILES = [f for f in IN_MEMORY_FILES if f["id"] != note_id]
        return jsonify({"status": "deleted", "id": note_id})


# ==========================================
# NOTE VERSIONS API
# ==========================================
@app.route("/api/v1/notes/<note_id>/versions", methods=["GET"])
@require_auth
def get_note_versions_api(note_id):
    global IN_MEMORY_VERSIONS
    versions = []
    if db:
        try:
            docs = db.collection("files").document(note_id).collection("versions").stream()
            versions = [d.to_dict() for d in docs]
        except Exception as e:
            print(f"Firestore GET versions error: {e}")

    if not versions:
        versions = [v for v in IN_MEMORY_VERSIONS if v["file_id"] == note_id]

    versions.sort(key=lambda x: x.get("saved_at", ""), reverse=True)
    return jsonify({"versions": versions, "count": len(versions)})


@app.route("/api/v1/notes/<note_id>/restore", methods=["POST"])
@require_auth
def restore_note_version_api(note_id):
    global IN_MEMORY_FILES, IN_MEMORY_VERSIONS
    uid = getattr(request, 'user_id', 'demo_user')
    data = request.get_json() or {}
    version_id = data.get("version_id")

    if not version_id:
        return jsonify({"detail": "version_id is required"}), 400

    target_version = None
    if db:
        try:
            doc = db.collection("files").document(note_id).collection("versions").document(version_id).get()
            if doc.exists:
                target_version = doc.to_dict()
        except Exception as e:
            print(f"Error fetching version from Firestore: {e}")

    if not target_version:
        target_version = next((v for v in IN_MEMORY_VERSIONS if v["id"] == version_id and v["file_id"] == note_id), None)

    if not target_version:
        return jsonify({"detail": "Version snapshot not found"}), 404

    now_str = datetime.datetime.now(datetime.timezone.utc).isoformat()
    patch_data = {
        "title": target_version.get("title", "Restored Note"),
        "content": target_version.get("content", ""),
        "updated_at": now_str
    }

    if db:
        try:
            db.collection("files").document(note_id).update(patch_data)
        except Exception as e:
            print(f"Firestore restore update error: {e}")

    note = next((f for f in IN_MEMORY_FILES if f["id"] == note_id), None)
    if note:
        note["title"] = patch_data["title"]
        note["content"] = patch_data["content"]
        note["updated_at"] = now_str

    save_version_snapshot(note_id, patch_data["title"], patch_data["content"], uid)
    return jsonify({"status": "restored", "title": patch_data["title"], "content": patch_data["content"]})


# ==========================================
# GLOBAL SEARCH API
# ==========================================
@app.route("/api/v1/search", methods=["GET"])
@require_auth
def global_search_api():
    global IN_MEMORY_FILES, IN_MEMORY_PROJECTS
    uid = getattr(request, 'user_id', 'demo_user')
    q = (request.args.get("q") or "").strip().lower()

    if not q:
        return jsonify({"projects": [], "notes": []})

    matched_projects = []
    matched_notes = []

    if db:
        try:
            p_docs = db.collection("projects").where("user_id", "==", uid).stream()
            for d in p_docs:
                p_data = d.to_dict()
                if q in p_data.get("title", "").lower() or q in p_data.get("description", "").lower():
                    matched_projects.append(p_data)

            n_docs = db.collection("files").where("user_id", "==", uid).stream()
            for d in n_docs:
                n_data = d.to_dict()
                if q in n_data.get("title", "").lower() or q in n_data.get("content", "").lower() or q in n_data.get("folder", "").lower():
                    matched_notes.append(n_data)
        except Exception as e:
            print(f"Firestore search error: {e}")

    if not matched_projects:
        matched_projects = [
            p for p in IN_MEMORY_PROJECTS 
            if (p["user_id"] == uid or uid == "demo_user") and (q in p.get("title", "").lower() or q in p.get("description", "").lower())
        ]

    if not matched_notes:
        matched_notes = [
            f for f in IN_MEMORY_FILES 
            if (f["user_id"] == uid or uid == "demo_user") and (q in f.get("title", "").lower() or q in f.get("content", "").lower() or q in f.get("folder", "").lower())
        ]

    return jsonify({"projects": matched_projects, "notes": matched_notes})


@app.route("/api/v1/projects/<project_id>/files/<file_id>/copy", methods=["POST"])
@require_auth
def copy_file_api(project_id, file_id):
    global IN_MEMORY_FILES
    uid = getattr(request, 'user_id', 'demo_user')
    now_str = datetime.datetime.now(datetime.timezone.utc).isoformat()

    file_obj = None
    if db:
        try:
            doc = db.collection("files").document(file_id).get()
            if doc.exists:
                file_obj = doc.to_dict()
        except Exception as e:
            print(f"Firestore copy get error: {e}")

    if not file_obj:
        file_obj = next((f for f in IN_MEMORY_FILES if f["id"] == file_id and f.get("project_id") == project_id), None)

    if not file_obj:
        title = "Copied Note"
        content = "Copied content"
        folder = "General"
        extension = "md"
    else:
        title = f"Copy of {file_obj.get('title', 'Untitled')}"
        content = file_obj.get('content', '')
        folder = file_obj.get('folder', 'General')
        extension = file_obj.get('extension', 'md')

    copy_file = {
        "id": f"nt_{secrets.token_hex(6)}",
        "user_id": uid,
        "project_id": project_id,
        "title": title,
        "content": content,
        "folder": folder,
        "extension": extension,
        "is_public": False,
        "created_at": now_str,
        "updated_at": now_str
    }

    if db:
        try:
            db.collection("files").document(copy_file["id"]).set(copy_file)
            return jsonify({"file": copy_file}), 201
        except Exception as e:
            print(f"Firestore copy set error: {e}")

    IN_MEMORY_FILES.insert(0, copy_file)
    return jsonify({"file": copy_file}), 201


# ==========================================
# DEVELOPER API KEYS
# ==========================================
@app.route("/api/v1/developer/keys", methods=["GET", "POST"])
@require_auth
def developer_keys_api():
    global IN_MEMORY_KEYS
    uid = getattr(request, 'user_id', 'demo_user')

    if request.method == "GET":
        keys_list = []
        if db:
            try:
                docs_ref = db.collection("api_keys").where("user_id", "==", uid).stream()
                for d in docs_ref:
                    kdata = d.to_dict()
                    if kdata.get("is_active", True):
                        keys_list.append(kdata)
                return jsonify({"keys": keys_list})
            except Exception as e:
                print(f"Firestore GET keys failed: {e}")

        active_keys = [k for k in IN_MEMORY_KEYS if k.get("user_id") == uid and k.get("is_active", True)]
        return jsonify({"keys": active_keys})

    elif request.method == "POST":
        data = request.get_json() or {}
        key_name = data.get("name", "Untitled API Key").strip() or "Untitled API Key"
        key_id = f"key_{secrets.token_hex(6)}"
        now_str = datetime.datetime.now(datetime.timezone.utc).isoformat()

        # 1. Generate Long-Lived JWT Token for developer
        payload = {
            "uid": uid,
            "key_id": key_id,
            "iat": datetime.datetime.now(datetime.timezone.utc).timestamp()
        }
        api_token = encode_jwt_token(payload)
        raw_key = f"vex_live_{secrets.token_hex(16)}"

        # 2. Key Metadata stored in Firestore / memory
        new_key_meta = {
            "id": key_id,
            "user_id": uid,
            "uid": uid,
            "name": key_name,
            "key": raw_key,
            "token_preview": f"{api_token[:12]}...{api_token[-8:]}",
            "is_active": True,
            "created_at": now_str
        }

        if db:
            try:
                db.collection("api_keys").document(key_id).set(new_key_meta)
            except Exception as e:
                print(f"Firestore POST key failed: {e}")

        IN_MEMORY_KEYS.insert(0, new_key_meta)
        return jsonify({
            "key_id": key_id,
            "name": key_name,
            "token": api_token,
            "key": raw_key,
            "message": "Please copy this token now. You will not be able to see it again."
        }), 201


@app.route("/api/v1/developer/keys/<key_id>", methods=["DELETE"])
@require_auth
def delete_developer_key_api(key_id):
    global IN_MEMORY_KEYS
    uid = getattr(request, 'user_id', 'demo_user')
    if db:
        try:
            doc_ref = db.collection("api_keys").document(key_id)
            doc = doc_ref.get()
            if doc.exists:
                doc_data = doc.to_dict()
                if doc_data.get("user_id") == uid or doc_data.get("uid") == uid or uid == "demo_user":
                    doc_ref.delete()
        except Exception as e:
            print(f"Firestore DELETE key failed: {e}")

    IN_MEMORY_KEYS = [k for k in IN_MEMORY_KEYS if k["id"] != key_id]
    return jsonify({"status": "revoked", "id": key_id})


# ==========================================
# GOOGLE KEEP API PROXY ENDPOINTS
# ==========================================
IN_MEMORY_KEEP_NOTES = [
    {
        "id": "keep_demo_01",
        "name": "notes/keep_demo_01",
        "title": "⚡ Project Vex Roadmap",
        "body": {"text": {"text": "1. Integrate Google Keep API for seamless note sync.\n2. Add smooth typewriter animation to h1.\n3. Support 1-click import and export between Keep & Vex."}},
        "createTime": datetime.datetime.now(datetime.timezone.utc).isoformat()
    },
    {
        "id": "keep_demo_02",
        "name": "notes/keep_demo_02",
        "title": "💡 Ideas for AI Workspace",
        "body": {"text": {"text": "Explore sparse attention mechanisms and KV cache compression for ultra-fast context processing in Gemini 2.5."}},
        "createTime": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }
]

@app.route("/api/v1/keep/notes", methods=["GET", "POST"])
def google_keep_notes_proxy():
    global IN_MEMORY_KEEP_NOTES
    auth_header = request.headers.get("Authorization")
    token = None
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header.split("Bearer ")[1].strip()

    if request.method == "GET":
        if token and token != "demo-token":
            try:
                resp = requests.get(
                    "https://keep.googleapis.com/v1/notes",
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=10
                )
                if resp.status_code == 200:
                    return jsonify(resp.json())
                else:
                    print(f"Google Keep API GET returned {resp.status_code}: {resp.text}")
                    # Return standard error details with fallback
                    return jsonify({
                        "error": "Google Keep API error",
                        "status_code": resp.status_code,
                        "details": resp.text,
                        "notes": IN_MEMORY_KEEP_NOTES
                    }), 200
            except Exception as e:
                print(f"Error fetching Keep notes: {e}")
                return jsonify({"notes": IN_MEMORY_KEEP_NOTES, "is_demo": True})
        
        return jsonify({"notes": IN_MEMORY_KEEP_NOTES, "is_demo": True})

    elif request.method == "POST":
        data = request.get_json() or {}
        title = data.get("title", "New Note")
        content = data.get("content", "")

        if token and token != "demo-token":
            try:
                payload = {
                    "title": title,
                    "body": {
                        "text": {
                            "text": content
                        }
                    }
                }
                resp = requests.post(
                    "https://keep.googleapis.com/v1/notes",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json"
                    },
                    json=payload,
                    timeout=10
                )
                if resp.status_code in [200, 201]:
                    return jsonify(resp.json()), 201
                else:
                    print(f"Google Keep API POST returned {resp.status_code}: {resp.text}")
            except Exception as e:
                print(f"Error creating Keep note: {e}")

        # Fallback in-memory creation for demo or offline
        new_keep = {
            "id": f"keep_demo_{secrets.token_hex(4)}",
            "name": f"notes/keep_demo_{secrets.token_hex(4)}",
            "title": title,
            "body": {"text": {"text": content}},
            "createTime": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }
        IN_MEMORY_KEEP_NOTES.insert(0, new_keep)
        return jsonify(new_keep), 201


@app.route("/api/v1/keep/notes/<path:note_id>", methods=["DELETE"])
def delete_keep_note_proxy(note_id):
    global IN_MEMORY_KEEP_NOTES
    auth_header = request.headers.get("Authorization")
    token = None
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header.split("Bearer ")[1].strip()

    if token and token != "demo-token":
        try:
            target = note_id if note_id.startswith("notes/") else f"notes/{note_id}"
            resp = requests.delete(
                f"https://keep.googleapis.com/v1/{target}",
                headers={"Authorization": f"Bearer {token}"},
                timeout=10
            )
            if resp.status_code in [200, 204]:
                return jsonify({"status": "deleted"})
        except Exception as e:
            print(f"Keep note delete error: {e}")

    IN_MEMORY_KEEP_NOTES = [n for n in IN_MEMORY_KEEP_NOTES if note_id not in n.get("name", "") and note_id not in n.get("id", "")]
    return jsonify({"status": "deleted"})


# ==========================================
# GEMINI AI CHAT ENDPOINT
# ==========================================
@app.route("/api/v1/ai/chat", methods=["POST"])
def ai_chat_api():
    data = request.get_json() or {}
    message = data.get("message")
    context = data.get("context", "")

    if not message or not isinstance(message, str):
        return jsonify({"detail": "Message string is required"}), 400

    if not GEMINI_API_KEY:
        return jsonify({
            "detail": "Gemini API key is not configured. Please add GEMINI_API_KEY to your environment variables."
        }), 503

    try:
        system_instruction = "You are Vex AI, an intelligent personal assistant for the Vex networked thought platform. You help users organize notes, synthesize complex ideas, summarize thoughts, write code and math equations, and answer queries concisely."
        if context:
            system_instruction += f"\n\nCurrent note context:\n{context}"

        # Try google.generativeai SDK if available
        if genai and hasattr(genai, "GenerativeModel"):
            try:
                model_name = GEMINI_MODEL if GEMINI_MODEL else "gemini-1.5-flash"
                model = genai.GenerativeModel(
                    model_name=model_name,
                    system_instruction=system_instruction
                )
                response = model.generate_content(message)
                if response and hasattr(response, "text") and response.text:
                    return jsonify({"reply": response.text})
            except Exception as sdk_err:
                print(f"google-generativeai SDK call notice, falling back to REST: {sdk_err}")

        # REST API fallback
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
        payload = {
            "systemInstruction": {
                "parts": [{"text": system_instruction}]
            },
            "contents": [
                {
                    "parts": [{"text": message}]
                }
            ]
        }
        resp = requests.post(url, json=payload, timeout=15)
        if resp.status_code == 200:
            res_data = resp.json()
            candidates = res_data.get("candidates", [])
            if candidates:
                text = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
                return jsonify({"reply": text or "No response generated."})

        return jsonify({"reply": f"Gemini API returned status code {resp.status_code}."})
    except Exception as e:
        print(f"Gemini API error: {e}")
        return jsonify({"detail": f"Error communicating with Gemini AI: {str(e)}"}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 3000)), debug=True)
