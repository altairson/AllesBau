# AllesBau — PythonAnywhere Hosting & Deployment Guide

This guide explains how to host your **AllesBau** Progressive Web App (PWA) with live multi-device SQLite database sync on **PythonAnywhere** for free.

---

## 📁 1. Project Files Checklist

Ensure your project contains these files:
```text
AllesBau/
├── backend/
│   ├── app.py              # Flask REST API & static file server
│   └── requirements.txt    # Flask & Flask-CORS
├── index.html              # Main PWA application page
├── app.js                  # Frontend client application logic
├── styles.css              # Custom styling & animations
├── manifest.json           # PWA configuration (standalone mode)
├── sw.js                   # Service worker (caching & offline shell)
├── icon.svg                # High-res app icon for mobile homescreen
├── pythonanywhere_wsgi.py   # WSGI configuration template
└── DEPLOYMENT.md           # This guide
```

---

## 🚀 2. Deploy to PythonAnywhere (5-Minute Step-by-Step)

### Step 1: Create a Free PythonAnywhere Account
1. Go to [pythonanywhere.com](https://www.pythonanywhere.com) and sign up for a **Beginner (Free)** account.
2. Note your **username** (your app URL will be `https://<your-username>.pythonanywhere.com`).

---

### Step 2: Upload Files to PythonAnywhere
**Option A: Upload as a ZIP (Easiest)**
1. On your computer, select all files in the `AllesBau` folder and compress them into `AllesBau.zip`.
2. In PythonAnywhere, go to the **Files** tab.
3. Under the `home/<your-username>/` directory, upload `AllesBau.zip`.
4. Open a **Bash Console** from the Consoles tab and extract the zip:
   ```bash
   unzip AllesBau.zip -d AllesBau
   ```

**Option B: Using Git (if using GitHub)**
1. In PythonAnywhere, open a **Bash Console**:
   ```bash
   git clone <your-repo-url> AllesBau
   ```

---

### Step 3: Install Python Dependencies
In the PythonAnywhere **Bash Console**, run:
```bash
pip install --user -r ~/AllesBau/backend/requirements.txt
```
*(This installs `Flask` and `Flask-CORS` for your user account).*

---

### Step 4: Configure the Web App
1. Go to the **Web** tab on PythonAnywhere.
2. Click **"Add a new web app"**.
3. Choose **Manual configuration** (NOT the automatic Flask wizard), and select **Python 3.10** (or Python 3.11/3.12).
4. After creation, scroll down to the **Code** section:
   - **Source code:** `/home/<your-username>/AllesBau`
   - **Working directory:** `/home/<your-username>/AllesBau/backend`
6. Click on the link next to **WSGI configuration file** (e.g., `/var/www/altairson_pythonanywhere_com_wsgi.py`).
7. Delete everything inside the WSGI editor and replace it with:
   ```python
   import sys
   import os

   home = os.path.expanduser('~')
   candidate_dirs = [
       os.path.join(home, 'AllesBau'),
       os.path.join(home, 'AllesBau', 'backend'),
       os.path.join(home, 'AllesBau', 'AllesBau'),
       os.path.join(home, 'backend'),
       home,
   ]
   for d in candidate_dirs:
       if os.path.exists(d) and d not in sys.path:
           sys.path.insert(0, d)

   try:
       from backend.app import app as application
   except ImportError:
       from app import app as application
   ```
8. Click the green **Save** button in the top right.

---

### Step 5: Reload Your Web App
1. Return to the **Web** tab.
2. Click the big green button: **"Reload <your-username>.pythonanywhere.com"**.
3. Your app is now live at:
   `https://<your-username>.pythonanywhere.com`

---

## 📱 3. Installing as a PWA on Phones (iOS & Android)

AllesBau is a Progressive Web App (PWA) with a standalone display mode (no browser address bars):

### On iPhone / iPad (Safari)
1. Open Safari and navigate to `https://<your-username>.pythonanywhere.com`.
2. Tap the **Share** button (box with an upward arrow) at the bottom.
3. Scroll down and tap **"Add to Home Screen"**.
4. Tap **Add** in the top right.
5. The **AllesBau** icon will appear on your home screen and open full-screen just like a native app.

### On Android (Chrome)
1. Open Chrome and navigate to `https://<your-username>.pythonanywhere.com`.
2. Tap the **three dots menu** (⋮) in the top-right corner.
3. Tap **"Install app"** or **"Add to Home screen"**.
4. Confirm installation. The app icon will appear in your app drawer and home screen.

---

## 👥 4. Multi-Device Workflow & First-Time Setup

1. **Crew Leader First-Time Setup:**
   - Open the app, switch to the **"Register Crew Leader"** tab.
   - Enter your **Company Name**, **Leader Full Name**, **Username**, and **Password**.
   - Tap **"Create Crew Account"**.
2. **Add Supervisors & Workers:**
   - As Crew Leader, tap the **"+ Add User"** button on the home screen.
   - Create a **Supervisor** account (name, username, password).
   - Create **Worker** accounts (name, username, password, hourly rate, phone).
3. **Multi-Device Live Connection:**
   - Give each supervisor and worker their own username and password.
   - They open `https://<your-username>.pythonanywhere.com` on their phones and sign in.
   - Workers see their live timer, logged shifts, earnings, and payout history.
   - Supervisors review, approve, or reject shifts and payments.
   - Changes sync across devices on every app open or refresh.

---

## 🕒 5. 30-Minute Interval Time Rounding Rule

AllesBau automatically enforces 30-minute rounding:
- If minutes are **> 15 and <= 45** ➔ rounds to **:30**
- If minutes are **<= 15** ➔ rounds down to **:00** of current hour
- If minutes are **> 45** ➔ rounds up to **:00** of next hour

*Examples:*
- `08:14` ➔ `08:00`
- `08:16` ➔ `08:30`
- `08:45` ➔ `08:30`
- `08:46` ➔ `09:00`
