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

# Get item/record ID from command line
if len(sys.argv) > 1:
    record_id = sys.argv[1]
else:
    record_id = input("Enter Record ID: ")

# Build the Airtable API URL
url = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_NAME}/{record_id}"

# Set up headers
headers = {
    "Authorization": f"Bearer {AIRTABLE_API_KEY}",
    "Content-Type": "application/json"
}

try:
    # Update the status field to "Completed" (or whatever status indicates domain setup is done)
    # Airtable doesn't have "groups" like monday.com, so we update a status field instead
    update_data = {
        "fields": {
            "Domain Setup Status": "Completed"  # Update status field
        }
    }

    print(f"Updating domain setup status for record: {record_id}")
    response = requests.patch(url, json=update_data, headers=headers)

    if response.status_code != 200:
        print(f"Failed to update status. Status code: {response.status_code}")
        print(response.text)
        sys.exit(1)

    updated_record = response.json()
    record_name = updated_record["fields"].get("Name", "Unknown")

    print(f"Domain setup status updated successfully for '{record_name}'")
    print(f"Status set to: Completed")

except requests.exceptions.RequestException as e:
    print(f"Network error: {str(e)}")
    sys.exit(1)
except Exception as e:
    print(f"Unexpected error: {str(e)}")
    sys.exit(1)
