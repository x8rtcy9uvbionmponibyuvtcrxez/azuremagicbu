import sys
import requests
import json
import os

# Get the directory where this script is located
script_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(script_dir, '.env')

# Function to load .env file manually (fallback if python-dotenv not installed)
def load_env_file(env_file_path):
    """Load environment variables from .env file manually"""
    if os.path.exists(env_file_path):
        with open(env_file_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ[key.strip()] = value.strip()

# Try to use python-dotenv if available, otherwise use manual loader
try:
    from dotenv import load_dotenv
    load_dotenv(env_path)
except ImportError:
    load_env_file(env_path)

if len(sys.argv) != 3:
    print("Usage: update_txt.py <domain> <txt_record_value>")
    sys.exit(1)

domain = sys.argv[1]
txt_record_value = sys.argv[2]

# Ensure the TXT record value is wrapped in quotation marks.
if not (txt_record_value.startswith('"') and txt_record_value.endswith('"')):
    txt_record_value = f'"{txt_record_value}"'

# Cloudflare API credentials from .env file
auth_key = os.getenv('CLOUDFLARE_API_KEY', '')
auth_email = os.getenv('CLOUDFLARE_EMAIL', '')

# Validate configuration
if not auth_key:
    print("Error: CLOUDFLARE_API_KEY not found in .env file")
    sys.exit(1)

if not auth_email:
    print("Error: CLOUDFLARE_EMAIL not found in .env file")
    sys.exit(1)

zone_id_url = "https://api.cloudflare.com/client/v4/zones"
dns_records_base_url = "https://api.cloudflare.com/client/v4/zones/"
headers = {
    "Content-Type": "application/json",
    "X-Auth-Email": auth_email,
    "X-Auth-Key": auth_key
}

def get_zone_id(domain):
    params = {"name": domain, "status": "active"}
    response = requests.get(zone_id_url, headers=headers, params=params)
    if response.status_code == 200:
        data = response.json()
        if data["result"]:
            return data["result"][0]["id"]
        else:
            print(f"No active zone found for domain: {domain}")
            return None
    else:
        print(f"Error fetching zone ID for {domain}. Status code: {response.status_code}")
        return None

def add_txt_record(zone_id, domain, txt_value):
    url = f"{dns_records_base_url}{zone_id}/dns_records"
    payload = {
        "type": "TXT",
        "name": domain,
        "content": txt_value,
        "ttl": 3600  # Adjust TTL if needed.
    }
    response = requests.post(url, headers=headers, json=payload)
    if response.status_code in (200, 201):
        print(f"TXT record added for {domain}.")
    else:
        print(f"Failed to add TXT record for {domain}. Status code: {response.status_code}, Response: {response.text}")

def main():
    zone_id = get_zone_id(domain)
    if zone_id:
        add_txt_record(zone_id, domain, txt_record_value)
    else:
        print("Could not retrieve zone ID.")

if __name__ == "__main__":
    main()
