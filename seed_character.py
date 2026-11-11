import requests

ADMIN_KEY = "DEATH GOD 999 @"
URL = "https://roleplay.singhvikas21571.workers.dev/admin/character/upsert"

with open(r"seed/hara_system.txt", "r", encoding="utf-8") as f:
    system_prompt = f.read()

with open(r"seed/hara_protocol.txt", "r", encoding="utf-8") as f:
    output_protocol_prompt = f.read()

payload = {
    "id": "hara",
    "name": "Hara",
    "avatar_url": "",
    "system_prompt": system_prompt,
    "output_protocol_prompt": output_protocol_prompt,
    "default_model": "gemma-4-31b",
}

headers = {
    "x-admin-key": ADMIN_KEY,
}

r = requests.post(URL, json=payload, headers=headers, timeout=60)
print("status:", r.status_code)
print(r.text)
r.raise_for_status()