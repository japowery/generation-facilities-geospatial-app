"""Small Windows wrapper for the static U.S. Generation Intelligence app."""

from __future__ import annotations

import hashlib
import hmac
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


APP_TITLE = "U.S. Generation Intelligence"


def _app_directory() -> Path:
    """Return the bundled app directory in development and one-file builds."""
    if getattr(sys, "_MEIPASS", None):
        return Path(sys._MEIPASS) / "app"
    return Path(__file__).resolve().parents[1]


def _password_hash() -> str:
    """Read the optional generated password hash without storing a secret in source."""
    try:
        from build_config import PASSWORD_HASH
    except ImportError:
        return ""
    return PASSWORD_HASH.strip().lower()


def _password_is_valid(password: str, expected_hash: str) -> bool:
    actual_hash = hashlib.sha256(password.encode("utf-8")).hexdigest()
    return hmac.compare_digest(actual_hash, expected_hash)


def _request_password(expected_hash: str) -> bool:
    """Show a small native password gate when a protected build is requested."""
    import tkinter as tk

    result = {"accepted": False}
    root = tk.Tk()
    root.title(APP_TITLE)
    root.resizable(False, False)
    root.configure(padx=24, pady=20)

    tk.Label(root, text=APP_TITLE, font=("Segoe UI", 13, "bold")).pack(anchor="w")
    tk.Label(root, text="Enter the release password to continue.", pady=8).pack(anchor="w")
    password_var = tk.StringVar()
    password_entry = tk.Entry(root, textvariable=password_var, show="•", width=34)
    password_entry.pack(fill="x")
    status = tk.Label(root, text="", fg="#b42318", pady=8)
    status.pack(anchor="w")

    def submit() -> None:
        if _password_is_valid(password_var.get(), expected_hash):
            result["accepted"] = True
            root.destroy()
        else:
            status.configure(text="That password is not valid.")
            password_var.set("")
            password_entry.focus_set()

    tk.Button(root, text="Continue", command=submit, default="active").pack(anchor="e")
    root.bind("<Return>", lambda _event: submit())
    root.protocol("WM_DELETE_WINDOW", root.destroy)
    password_entry.focus_set()
    root.mainloop()
    return result["accepted"]


def _make_handler(directory: Path):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, _format, *_args):
            return

    return Handler


def _start_server() -> tuple[ThreadingHTTPServer, int]:
    app_directory = _app_directory()
    if not (app_directory / "index.html").is_file():
        raise FileNotFoundError(f"Application shell not found in {app_directory}")

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _make_handler(app_directory))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def main() -> None:
    expected_hash = _password_hash()
    if expected_hash and not _request_password(expected_hash):
        return

    httpd, port = _start_server()
    url = f"http://127.0.0.1:{port}/index.html"

    try:
        import webview

        webview.create_window(APP_TITLE, url, width=1500, height=900, min_size=(1100, 700))
        webview.start(debug=False)
    except Exception:
        webbrowser.open(url)
        input("The app opened in your browser. Press Enter to quit...\n")
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
