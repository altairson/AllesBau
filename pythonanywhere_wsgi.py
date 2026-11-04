# =====================================================================
# PythonAnywhere WSGI Configuration File for AllesBau PWA
# =====================================================================
# In PythonAnywhere Web tab:
# 1. Click your WSGI configuration file link (/var/www/altairson_pythonanywhere_com_wsgi.py)
# 2. Delete everything and paste this entire file content.
# 3. Save and click Reload!
# =====================================================================

import sys
import os

# Automatically detect home directory (e.g. /home/altairson)
home = os.path.expanduser('~')

# Add all possible project locations to sys.path
candidate_dirs = [
    os.path.join(home, 'AllesBau'),
    os.path.join(home, 'AllesBau', 'backend'),
    os.path.join(home, 'AllesBau', 'AllesBau'),
    os.path.join(home, 'AllesBau', 'AllesBau', 'backend'),
    os.path.join(home, 'backend'),
    home,
]

for d in candidate_dirs:
    if os.path.exists(d) and d not in sys.path:
        sys.path.insert(0, d)

# Import Flask application object
application = None

# Attempt 1: from backend.app import app
try:
    from backend.app import app as application
except ImportError:
    pass

# Attempt 2: from app import app (if backend directory was added to path)
if application is None:
    try:
        from app import app as application
    except ImportError:
        pass

# Attempt 3: Deep search in home folder for app.py
if application is None:
    for root, dirs, files in os.walk(home):
        if 'app.py' in files and ('backend' in root or 'AllesBau' in root):
            if root not in sys.path:
                sys.path.insert(0, root)
            parent = os.path.dirname(root)
            if parent not in sys.path:
                sys.path.insert(0, parent)
            try:
                from backend.app import app as application
                break
            except ImportError:
                try:
                    from app import app as application
                    break
                except ImportError:
                    pass

if application is None:
    raise RuntimeError(
        f"Could not import Flask application. "
        f"Home directory: {home}, contents: {os.listdir(home) if os.path.exists(home) else 'N/A'}. "
        f"sys.path: {sys.path}"
    )
