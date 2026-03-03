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

# Airtable configuration
AIRTABLE_API_KEY = os.getenv('AIRTABLE_API_KEY', '')
AIRTABLE_BASE_ID = os.getenv('AIRTABLE_BASE_ID', '')
AIRTABLE_TABLE_NAME = os.getenv('AIRTABLE_TABLE_NAME', 'Tenants')

# Cloudflare configuration
CLOUDFLARE_API_KEY = os.getenv('CLOUDFLARE_API_KEY', '')
CLOUDFLARE_EMAIL = os.getenv('CLOUDFLARE_EMAIL', '')

# Validate configuration
if not AIRTABLE_API_KEY:
    print("Error: AIRTABLE_API_KEY not found in .env file")
    exit(1)

if not AIRTABLE_BASE_ID:
    print("Error: AIRTABLE_BASE_ID not found in .env file")
    exit(1)

if not CLOUDFLARE_API_KEY:
    print("Error: CLOUDFLARE_API_KEY not found in .env file")
    exit(1)

if not CLOUDFLARE_EMAIL:
    print("Error: CLOUDFLARE_EMAIL not found in .env file")
    exit(1)

# Airtable API setup
airtable_url = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_NAME}"
airtable_headers = {
    "Authorization": f"Bearer {AIRTABLE_API_KEY}",
    "Content-Type": "application/json"
}

# Cloudflare API setup
cloudflare_zone_url = "https://api.cloudflare.com/client/v4/zones"
cloudflare_headers = {
    "Content-Type": "application/json",
    "X-Auth-Email": CLOUDFLARE_EMAIL,
    "X-Auth-Key": CLOUDFLARE_API_KEY
}

print("=" * 80)
print("Cloudflare Zone Creation & Configuration - Airtable Integration")
print("=" * 80)
print()

# Step 1: Retrieve all records from Airtable where Nameservers is empty
print("Step 1: Retrieving records from Airtable where Nameservers is empty...")

try:
    # Filter by empty Nameservers field
    # Airtable formula: OR({Nameservers} = '', {Nameservers} = BLANK())
    params = {
        "filterByFormula": "OR({Nameservers} = '', {Nameservers} = BLANK())"
    }

    response = requests.get(airtable_url, headers=airtable_headers, params=params)

    if response.status_code != 200:
        print(f"Error retrieving records from Airtable: {response.status_code}")
        print(response.text)
        exit(1)

    data = response.json()
    records = data.get("records", [])

    if not records:
        print("No records found with empty Nameservers field.")
        print("All domains already have nameservers assigned!")
        exit(0)

    print(f"Found {len(records)} record(s) without nameservers.")
    print()

except Exception as e:
    print(f"Error querying Airtable: {e}")
    exit(1)

# Step 2: Process each record
successful = 0
failed = 0

for record in records:
    record_id = record["id"]
    fields = record["fields"]
    domain = fields.get("Domain", "").strip()

    if not domain:
        print(f"⚠️  Skipping record {record_id} - No domain specified")
        failed += 1
        continue

    tenant_name = fields.get("Name", domain)
    forwarding_url = fields.get("Forwarding URL", "").strip()

    print("-" * 80)
    print(f"Processing: {domain} (Tenant: {tenant_name})")
    print("-" * 80)

    # Step 2a: Create Cloudflare zone
    print(f"  Creating Cloudflare zone for {domain}...")

    zone_payload = {
        "name": domain,
        "type": "full"
    }

    try:
        zone_response = requests.post(cloudflare_zone_url, headers=cloudflare_headers, json=zone_payload)

        if zone_response.status_code not in (200, 201):
            print(f"  ❌ Error creating zone: {zone_response.status_code}")
            print(f"     Response: {zone_response.text}")
            failed += 1
            continue

        zone_data = zone_response.json()

        if not zone_data.get("success"):
            print(f"  ❌ Zone creation unsuccessful: {zone_data}")
            failed += 1
            continue

        zone_result = zone_data.get("result", {})
        zone_id = zone_result.get("id")
        ns_list = zone_result.get("name_servers", [])

        if not zone_id or len(ns_list) < 2:
            print(f"  ❌ Invalid zone response - missing zone ID or nameservers")
            failed += 1
            continue

        ns1 = ns_list[0]
        ns2 = ns_list[1]
        nameservers = f"{ns1}, {ns2}"

        print(f"  ✅ Zone created successfully!")
        print(f"     Zone ID: {zone_id}")
        print(f"     Nameserver 1: {ns1}")
        print(f"     Nameserver 2: {ns2}")

    except Exception as e:
        print(f"  ❌ Exception during zone creation: {e}")
        failed += 1
        continue

    # Step 2b: Delete existing DNS records
    print(f"  Deleting existing DNS records...")

    dns_records_url = f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records"

    try:
        # Get all DNS records
        records_response = requests.get(dns_records_url, headers=cloudflare_headers)

        if records_response.status_code == 200:
            records_data = records_response.json()
            existing_records = records_data.get("result", [])

            if existing_records:
                deleted_count = 0
                for dns_record in existing_records:
                    record_id_dns = dns_record.get("id")
                    delete_url = f"{dns_records_url}/{record_id_dns}"
                    delete_response = requests.delete(delete_url, headers=cloudflare_headers)

                    if delete_response.status_code == 200:
                        deleted_count += 1

                print(f"  ✅ Deleted {deleted_count} existing DNS record(s)")
            else:
                print(f"  ℹ️  No existing DNS records to delete")
        else:
            print(f"  ⚠️  Could not retrieve DNS records: {records_response.status_code}")

    except Exception as e:
        print(f"  ⚠️  Error deleting DNS records (non-critical): {e}")

    # Step 2c: Create new DNS records
    print(f"  Creating DNS records...")

    dns_records_created = {
        "SPF": False,
        "DMARC": False,
        "MX": False,
        "CNAME": False,
        "A_@": False,
        "A_www": False
    }

    try:
        # SPF Record
        spf_payload = {
            "type": "TXT",
            "name": "@",
            "content": "v=spf1 include:spf.protection.outlook.com -all",
            "ttl": 3600
        }
        spf_response = requests.post(dns_records_url, headers=cloudflare_headers, json=spf_payload)
        if spf_response.status_code in (200, 201) and spf_response.json().get("success"):
            dns_records_created["SPF"] = True
            print(f"    ✅ SPF record created")
        else:
            print(f"    ❌ SPF record failed: {spf_response.text}")

        # DMARC Record
        dmarc_payload = {
            "type": "TXT",
            "name": "_dmarc",
            "content": "v=DMARC1; p=none;",
            "ttl": 3600
        }
        dmarc_response = requests.post(dns_records_url, headers=cloudflare_headers, json=dmarc_payload)
        if dmarc_response.status_code in (200, 201) and dmarc_response.json().get("success"):
            dns_records_created["DMARC"] = True
            print(f"    ✅ DMARC record created")
        else:
            print(f"    ❌ DMARC record failed: {dmarc_response.text}")

        # MX Record
        mail_target = f"{domain.replace('.', '-')}.mail.protection.outlook.com"
        mx_payload = {
            "type": "MX",
            "name": "@",
            "content": mail_target,
            "ttl": 3600,
            "priority": 0
        }
        mx_response = requests.post(dns_records_url, headers=cloudflare_headers, json=mx_payload)
        if mx_response.status_code in (200, 201) and mx_response.json().get("success"):
            dns_records_created["MX"] = True
            print(f"    ✅ MX record created ({mail_target})")
        else:
            print(f"    ❌ MX record failed: {mx_response.text}")

        # CNAME Record for autodiscover
        cname_payload = {
            "type": "CNAME",
            "name": "autodiscover",
            "content": "autodiscover.outlook.com",
            "ttl": 3600,
            "proxied": False
        }
        cname_response = requests.post(dns_records_url, headers=cloudflare_headers, json=cname_payload)
        if cname_response.status_code in (200, 201) and cname_response.json().get("success"):
            dns_records_created["CNAME"] = True
            print(f"    ✅ CNAME record created (autodiscover)")
        else:
            print(f"    ❌ CNAME record failed: {cname_response.text}")

        # A Record: @ pointing to 44.227.65.245 with proxied true
        a_record_payload1 = {
            "type": "A",
            "name": "@",
            "content": "44.227.65.245",
            "ttl": 3600,
            "proxied": True
        }
        a_response1 = requests.post(dns_records_url, headers=cloudflare_headers, json=a_record_payload1)
        if a_response1.status_code in (200, 201) and a_response1.json().get("success"):
            dns_records_created["A_@"] = True
            print(f"    ✅ A record created (@ → 44.227.65.245)")
        else:
            print(f"    ❌ A record @ failed: {a_response1.text}")

        # A Record: www pointing to 44.227.65.245 with proxied true
        a_record_payload2 = {
            "type": "A",
            "name": "www",
            "content": "44.227.65.245",
            "ttl": 3600,
            "proxied": True
        }
        a_response2 = requests.post(dns_records_url, headers=cloudflare_headers, json=a_record_payload2)
        if a_response2.status_code in (200, 201) and a_response2.json().get("success"):
            dns_records_created["A_www"] = True
            print(f"    ✅ A record created (www → 44.227.65.245)")
        else:
            print(f"    ❌ A record www failed: {a_response2.text}")

        successful_records = sum(dns_records_created.values())
        print(f"  ✅ Created {successful_records}/6 DNS records successfully")

    except Exception as e:
        print(f"  ❌ Exception creating DNS records: {e}")

    # Step 2d: Configure forwarding ruleset (if forwarding URL provided)
    if forwarding_url:
        print(f"  Configuring forwarding to: {forwarding_url}")

        try:
            # Check if a ruleset already exists
            rulesets_url = f"https://api.cloudflare.com/client/v4/zones/{zone_id}/rulesets"
            rulesets_response = requests.get(rulesets_url, headers=cloudflare_headers)

            existing_ruleset_id = None

            if rulesets_response.status_code == 200:
                rulesets_data = rulesets_response.json()
                rulesets = rulesets_data.get("result", [])

                # Look for http_request_dynamic_redirect ruleset
                for ruleset in rulesets:
                    if ruleset.get("phase") == "http_request_dynamic_redirect":
                        existing_ruleset_id = ruleset.get("id")
                        break

            ruleset_payload = {
                "name": "redirect",
                "kind": "zone",
                "phase": "http_request_dynamic_redirect",
                "rules": [
                    {
                        "expression": "true",
                        "action": "redirect",
                        "action_parameters": {
                            "from_value": {
                                "target_url": {
                                    "value": forwarding_url
                                },
                                "status_code": 301
                            }
                        }
                    }
                ]
            }

            if existing_ruleset_id:
                # Update existing ruleset
                update_ruleset_url = f"{rulesets_url}/{existing_ruleset_id}"
                ruleset_response = requests.put(update_ruleset_url, headers=cloudflare_headers, json=ruleset_payload)

                if ruleset_response.status_code == 200 and ruleset_response.json().get("success"):
                    print(f"  ✅ Updated existing forwarding ruleset")
                else:
                    print(f"  ⚠️  Failed to update ruleset: {ruleset_response.text}")
            else:
                # Create new ruleset
                ruleset_response = requests.post(rulesets_url, headers=cloudflare_headers, json=ruleset_payload)

                if ruleset_response.status_code in (200, 201) and ruleset_response.json().get("success"):
                    print(f"  ✅ Created new forwarding ruleset")
                else:
                    print(f"  ⚠️  Failed to create ruleset: {ruleset_response.text}")

        except Exception as e:
            print(f"  ⚠️  Exception configuring forwarding (non-critical): {e}")
    else:
        print(f"  ℹ️  No forwarding URL provided - skipping ruleset configuration")

    # Step 2e: Update Airtable with Zone ID and Nameservers
    print(f"  Updating Airtable record...")

    update_url = f"{airtable_url}/{record_id}"
    update_data = {
        "fields": {
            "Zone ID": zone_id,
            "Nameservers": nameservers
        }
    }

    try:
        update_response = requests.patch(update_url, headers=airtable_headers, json=update_data)

        if update_response.status_code != 200:
            print(f"  ❌ Failed to update Airtable: {update_response.status_code}")
            print(f"     Response: {update_response.text}")
            print(f"     WARNING: Zone was created but Airtable was not updated!")
            print(f"     Manual update needed:")
            print(f"       Zone ID: {zone_id}")
            print(f"       Nameservers: {nameservers}")
            failed += 1
            continue

        print(f"  ✅ Airtable updated successfully!")
        successful += 1

    except Exception as e:
        print(f"  ❌ Exception updating Airtable: {e}")
        print(f"     WARNING: Zone was created but Airtable was not updated!")
        print(f"     Manual update needed:")
        print(f"       Zone ID: {zone_id}")
        print(f"       Nameservers: {nameservers}")
        failed += 1
        continue

    print()

# Step 3: Summary
print("=" * 80)
print("SUMMARY")
print("=" * 80)
print(f"Total records processed: {len(records)}")
print(f"✅ Successfully created: {successful}")
print(f"❌ Failed: {failed}")
print()

if successful > 0:
    print("Configuration completed:")
    print("✅ Cloudflare zones created")
    print("✅ DNS records configured (SPF, DMARC, MX, CNAME, A records)")
    print("✅ Forwarding rulesets configured (where applicable)")
    print()
    print("Next steps for each domain:")
    print("1. Go to the domain registrar (GoDaddy, Namecheap, etc.)")
    print("2. Update the nameservers to the ones shown above")
    print("3. Wait 24-48 hours for DNS propagation")
    print("4. Verify DNS records are resolving correctly")
    print()

print("All done!")
