import subprocess
import sys
import json

def main():
    if len(sys.argv) < 2:
        print("Error: Tenant Name parameter is required.")
        sys.exit(1)
    tenant_name = sys.argv[1]

    # Execute retrieve_domain_credentials_airtable.py with tenant name and capture the JSON output
    try:
        output = subprocess.check_output(
            [sys.executable, "retrieve_domain_credentials_airtable.py", tenant_name],
            universal_newlines=True
        )
        print("Raw output from retrieve_domain_credentials_airtable.py:", output.strip())
    except subprocess.CalledProcessError as e:
        print("Error executing retrieve_domain_credentials.py:", e)
        sys.exit(1)
    
    try:
        credentials = json.loads(output)
    except json.JSONDecodeError as e:
        print("Error decoding JSON from retrieve_domain_credentials.py:", e)
        sys.exit(1)
        
    if "error" in credentials:
        print("Error:", credentials["error"])
        sys.exit(1)
    
    # Extract necessary fields from the JSON object - ensure exact case matching
    domainName = credentials.get("domainName", "")
    AdminEmail = credentials.get("AdminEmail", "")
    AdminPassword = credentials.get("AdminPassword", "")
    Alias = credentials.get("Alias", "")
    item_id = credentials.get("itemId", "")  # Case is important - using "itemId" not "item_id"
    tenant_id = credentials.get("TenantID", "")  # Case is important - using "TenantID" not "tenant_id"
    
    print(f"DEBUG - Parsed values:")
    print(f"Domain: {domainName}")
    print(f"Email: {AdminEmail}")
    print(f"Password: {'*' * len(AdminPassword)}")  # Mask the password for security
    print(f"Alias: {Alias}")
    print(f"Item ID: {item_id}")
    print(f"Tenant ID: {tenant_id}")

    # Create a temporary PowerShell script that will be used to pass parameters correctly
    with open("run_script1_future.ps1", "w") as f:
        f.write(f"""
# This is a temporary script to handle special characters in parameters
$domainName = '{domainName.replace("'", "''")}'
$AdminEmail = '{AdminEmail.replace("'", "''")}'
$AdminPassword = '{AdminPassword.replace("'", "''")}'
$Alias = '{Alias.replace("'", "''")}'
$item_id = '{item_id.replace("'", "''")}'
$tenant_id = '{tenant_id.replace("'", "''")}'
$tenant_name = '{tenant_name.replace("'", "''")}'

# Call the actual script with parameters
./script1_future.ps1 -domainName $domainName -AdminEmail $AdminEmail -AdminPassword $AdminPassword -Alias $Alias -item_id $item_id -tenant_id $tenant_id -tenant_name $tenant_name
""")
    
    # Build the PowerShell command to execute script1_future.ps1 with the parameters
    ps_cmd = [
        "cmd.exe",
        "/c",
        "start",
        "",
        "powershell.exe",
        "-NoExit",
        "-ExecutionPolicy", "Bypass",
        "-File", "run_script1_future.ps1"
    ]
    
    try:
        subprocess.run(ps_cmd, check=True)
    except subprocess.CalledProcessError as e:
        print("Error executing script1_future.ps1:", e)
        sys.exit(1)

if __name__ == "__main__":
    main()
