import requests
import json
import sys
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

# Airtable configuration
AIRTABLE_API_KEY = os.getenv('AIRTABLE_API_KEY', '')
AIRTABLE_BASE_ID = os.getenv('AIRTABLE_BASE_ID', '')
AIRTABLE_TABLE_NAME = os.getenv('AIRTABLE_TABLE_NAME', 'Tenants')

# Validate configuration
if not AIRTABLE_API_KEY:
    print("Error: AIRTABLE_API_KEY not found in .env file")
    sys.exit(1)

if not AIRTABLE_BASE_ID:
    print("Error: AIRTABLE_BASE_ID not found in .env file")
    sys.exit(1)

# Check if we have the required command line arguments
if len(sys.argv) < 3:
    print("Usage: python update_org_id_airtable.py <tenant_name> <org_id>")
    sys.exit(1)

tenant = sys.argv[1]
org_id = sys.argv[2]

# Build the Airtable API URL
url = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_NAME}"

# Set up headers
headers = {
    "Authorization": f"Bearer {AIRTABLE_API_KEY}",
    "Content-Type": "application/json"
}

# Filter by tenant name to find the record
params = {
    "filterByFormula": f"{{Name}} = '{tenant}'"
}

try:
    # Step 1: Find the record by tenant name
    print(f"Searching for tenant: {tenant}")
    response = requests.get(url, headers=headers, params=params)

    if response.status_code != 200:
        print(f"Error calling Airtable API: {response.status_code} - {response.text}")
        sys.exit(1)

    data = response.json()

    # Check if any records were found
    if not data.get("records") or len(data["records"]) == 0:
        print(f"No record found with tenant name '{tenant}'")
        sys.exit(1)

    # Get the first matching record
    record = data["records"][0]
    record_id = record["id"]
    record_name = record["fields"].get("Name", "")

    print(f"Found record: {record_name} (ID: {record_id})")

    # Step 2: Update the Tenant ID field with organization ID
    update_url = f"{url}/{record_id}"
    update_data = {
        "fields": {
            "Tenant ID": org_id  # Update the "Tenant ID" field with organization ID
        }
    }

    print(f"Updating Tenant ID to: {org_id}")
    update_response = requests.patch(update_url, json=update_data, headers=headers)

    if update_response.status_code != 200:
        print(f"Error updating record: {update_response.status_code} - {update_response.text}")
        sys.exit(1)

    updated_record = update_response.json()

    print(f"Successfully updated Tenant ID for tenant '{record_name}' (ID: {record_id})")
    print(f"New Tenant ID: {org_id}")

except requests.exceptions.RequestException as e:
    print(f"Network error: {str(e)}")
    sys.exit(1)
except Exception as e:
    print(f"Unexpected error: {str(e)}")
    sys.exit(1)
