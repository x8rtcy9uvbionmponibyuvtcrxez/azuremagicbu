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

if len(sys.argv) != 4:
    print("Usage: update_dkim.py <domain> <selector1_value> <selector2_value>")
    sys.exit(1)

domain = sys.argv[1]
selector1_value = sys.argv[2]
selector2_value = sys.argv[3]

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
    """Get the Cloudflare zone ID for a domain"""
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

def add_dkim_records(zone_id, domain, selector1_value, selector2_value):
    """Add DKIM CNAME records to Cloudflare"""
    url = f"{dns_records_base_url}{zone_id}/dns_records"

    # Define the two DKIM CNAME records
    records = [
        {
            "type": "CNAME",
            "name": f"selector1._domainkey.{domain}",
            "content": selector1_value,
            "ttl": 3600,
            "proxied": False
        },
        {
            "type": "CNAME",
            "name": f"selector2._domainkey.{domain}",
            "content": selector2_value,
            "ttl": 3600,
            "proxied": False
        }
    ]

    success_count = 0
    errors = []

    for record in records:
        try:
            response = requests.post(url, headers=headers, json=record)
            if response.status_code in (200, 201):
                print(f"  [OK] Added DKIM CNAME: {record['name']} -> {record['content']}")
                success_count += 1
            else:
                error_msg = f"Failed to add {record['name']}: {response.status_code}, {response.text}"
                print(f"  [ERROR] {error_msg}")
                errors.append(error_msg)
        except Exception as e:
            error_msg = f"Exception adding {record['name']}: {str(e)}"
            print(f"  [ERROR] {error_msg}")
            errors.append(error_msg)

    return success_count, errors

def main():
    print(f"Processing DKIM records for domain: {domain}")

    # Get zone ID
    zone_id = get_zone_id(domain)
    if not zone_id:
        print("Could not retrieve zone ID for domain")
        sys.exit(1)

    print(f"Zone ID: {zone_id}")

    # Add DKIM records
    success_count, errors = add_dkim_records(zone_id, domain, selector1_value, selector2_value)

    # Report results
    if success_count == 2:
        print(f"\n[SUCCESS] Added {success_count}/2 DKIM records for {domain}")
    elif success_count > 0:
        print(f"\n[PARTIAL] Added {success_count}/2 DKIM records")
        print("Errors:")
        for error in errors:
            print(f"  - {error}")
        sys.exit(1)
    else:
        print("\n[FAILED] Could not add any DKIM records")
        print("Errors:")
        for error in errors:
            print(f"  - {error}")
        sys.exit(1)

if __name__ == "__main__":
    main()
