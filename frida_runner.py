import frida
import sys
import os
import time

SCRIPTS = [
    os.path.join(os.path.dirname(__file__), "ws_hook_redirect.js"),
    os.path.join(os.path.dirname(__file__), "ws_hook_certbypass.js"),
]

def on_message(msg, data):
    if msg['type'] == 'send':
        print(f"[js] {msg['payload']}")
    elif msg['type'] == 'error':
        print(f"[error] {msg}")

def main():
    print("[runner] Looking for Gorilla Tag process...")
    try:
        session = frida.attach("Gorilla Tag.exe")
        print(f"[runner] Attached to Gorilla Tag")
    except Exception as e:
        print(f"[runner] Failed to attach: {e}")
        print("[runner] Is the game running?")
        sys.exit(1)

    for path in SCRIPTS:
        with open(path, 'r') as f:
            js_code = f.read()
        script = session.create_script(js_code)
        script.on('message', on_message)
        script.load()
        print(f"[runner] Loaded {os.path.basename(path)} ({len(js_code)} bytes)")

    print("[runner] All scripts loaded. Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("[runner] Shutting down...")
        session.detach()

if __name__ == "__main__":
    main()
