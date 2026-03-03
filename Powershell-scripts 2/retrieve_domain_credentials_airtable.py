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
    env_vars = {}
    if os.path.exists(env_file_path):
        with open(env_file_path, 'r') as f:
            for line in f:
                line = line.strip()
                # Skip empty lines and comments
                if line and not line.startswith('#'):
                    if '=' in line:
                        key, value = line.split('=', 1)
                        env_vars[key.strip()] = value.strip()
                        # Also set in os.environ for os.getenv() to work
                        os.environ[key.strip()] = value.strip()
    return env_vars

# Try to use python-dotenv if available, otherwise use manual loader
try:
    from dotenv import load_dotenv
    load_dotenv(env_path)
except ImportError:
    # python-dotenv not installed, use manual loader
    load_env_file(env_path)

# Airtable configuration
AIRTABLE_API_KEY = os.getenv('AIRTABLE_API_KEY', '')
AIRTABLE_BASE_ID = os.getenv('AIRTABLE_BASE_ID', '')
AIRTABLE_TABLE_NAME = os.getenv('AIRTABLE_TABLE_NAME', 'Tenants')

# Validate configuration
if not AIRTABLE_API_KEY:
    print(json.dumps({"error": "AIRTABLE_API_KEY not found in .env file"}))
    sys.exit(1)

if not AIRTABLE_BASE_ID:
    print(json.dumps({"error": "AIRTABLE_BASE_ID not found in .env file"}))
    sys.exit(1)

# Prompt the user for the tenant name
if len(sys.argv) > 1:
    tenant = sys.argv[1]
else:
    tenant = input("Enter Tenant name: ")

# Build the Airtable API URL
# Using REST API v0 which allows field names directly (not field IDs)
url = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_NAME}"

# Set up headers
headers = {
    "Authorization": f"Bearer {AIRTABLE_API_KEY}",
    "Content-Type": "application/json"
}

# Filter by tenant name (Name field)
# Using filterByFormula to find exact match
params = {
    "filterByFormula": f"{{Name}} = '{tenant}'"
}

try:
    # Make the API request
    response = requests.get(url, headers=headers, params=params)

    if response.status_code != 200:
        print(json.dumps({"error": f"Error calling Airtable API: {response.status_code} - {response.text}"}))
        sys.exit(1)

    data = response.json()

    # Check if any records were found
    if not data.get("records") or len(data["records"]) == 0:
        print(json.dumps({"error": f"No record found with tenant name '{tenant}'"}))
        sys.exit(1)

    # Use the first matching record
    record = data["records"][0]
    record_id = record["id"]
    fields = record["fields"]

    # Extract fields using field names directly (NO RANDOM IDs!)
    # Map from CSV columns to expected output
    domainName = fields.get("Domain", "")
    InboxNames = fields.get("Inbox Names", "")
    AdminEmail = fields.get("Admin Email", "")
    AdminPassword = fields.get("Admin Password", "")
    Alias = fields.get("Alias Name", "")
    TenantID = fields.get("Tenant ID", "")
    Client = fields.get("Client", "")

    # Validate required fields
    if not domainName:
        print(json.dumps({"error": "Domain field is empty or missing"}))
        sys.exit(1)

    if not InboxNames:
        print(json.dumps({"error": "Inbox Names field is empty or missing"}))
        sys.exit(1)

    if not AdminEmail:
        print(json.dumps({"error": "Admin Email field is empty or missing"}))
        sys.exit(1)

    if not AdminPassword:
        print(json.dumps({"error": "Admin Password field is empty or missing"}))
        sys.exit(1)

    # Return the results as a JSON object
    # Maintaining same structure as monday.com version for compatibility
    result = {
        "itemId": record_id,
        "subitemId": record_id,  # Airtable doesn't have subitems, using same ID
        "domainName": domainName,
        "InboxNames": InboxNames,
        "AdminEmail": AdminEmail,
        "AdminPassword": AdminPassword,
        "Alias": Alias,
        "Client": Client,
        "TenantID": TenantID
    }

    print(json.dumps(result))

except requests.exceptions.RequestException as e:
    print(json.dumps({"error": f"Network error: {str(e)}"}))
    sys.exit(1)
except Exception as e:
    print(json.dumps({"error": f"Unexpected error: {str(e)}"}))
    sys.exit(1)
