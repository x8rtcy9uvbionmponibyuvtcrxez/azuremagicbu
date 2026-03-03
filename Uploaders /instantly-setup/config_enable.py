#!/usr/bin/env python3
import requests
import json
import sys
import time
from urllib.parse import quote
from tqdm import tqdm

def get_accounts(v2_api_key, domain):
    """
    Get accounts for the given domain using the V2 API.
    """
    url = f"https://api.instantly.ai/api/v2/accounts?limit=100&provider_code=3&search={quote(domain)}"
    headers = {
        "Authorization": f"Bearer {v2_api_key}",
        "Content-Type": "application/json"
    }
    
    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"Error fetching accounts: {e}")
        return None

def patch_account(v2_api_key, email):
    """
    Patch account with predefined settings using the V2 API.
    """
    url = f"https://api.instantly.ai/api/v2/accounts/{quote(email)}"
    headers = {
        "Authorization": f"Bearer {v2_api_key}",
        "Content-Type": "application/json"
    }
    
    data = {
        "warmup": {
            "limit": 5,
            "increment": "2",
            "reply_rate": 30,
            "enable_slow_ramp": True
        },
        "daily_limit": 5,
        "sending_gap": 61,
        "skip_cname_check": True
    }
    
    try:
        response = requests.patch(url, headers=headers, json=data)
        response.raise_for_status()
        return True
    except requests.exceptions.RequestException as e:
        print(f"Error patching account {email}: {e}")
        return False

def enable_warmup(v1_api_key, email):
    """
    Enable warmup for an account using the V1 API.
    """
    url = "https://api.instantly.ai/api/v1/account/warmup/enable"
    headers = {
        "Content-Type": "application/json"
    }
    
    payload = json.dumps({
        "api_key": v1_api_key,
        "email": email
    })
    
    try:
        response = requests.post(url, headers=headers, data=payload)
        print(f"Enabling warmup for {email}: {response.text}")
        return response.status_code == 200
    except requests.exceptions.RequestException as e:
        print(f"Error enabling warmup for {email}: {e}")
        return False

def process_domain(v1_api_key, v2_api_key, domain, show_progress=True):
    """
    Process a domain: get accounts, patch them with V2 API, and enable warmup with V1 API.
    Returns (v2_success_count, v1_success_count, total_accounts)
    """
    print(f"\nFetching accounts for domain: {domain}")
    accounts_data = get_accounts(v2_api_key, domain)
    
    if not accounts_data or "items" not in accounts_data:
        print("No accounts found or error occurred.")
        return 0, 0, 0
    
    accounts = accounts_data["items"]
    total = len(accounts)
    print(f"Found {total} accounts for domain {domain}")
    
    v2_success_count = 0
    v1_success_count = 0
    
    # Check if running as a subprocess
    is_subprocess = not sys.stdin.isatty()
    
    if show_progress and not is_subprocess:
        # Use tqdm only when running interactively, not as a subprocess
        iterator = tqdm(accounts, desc="Processing Accounts", unit="account")
    else:
        iterator = accounts
        # Print a header for the processing log
        print(f"Processing {total} accounts:")
    
    for i, account in enumerate(iterator):
        email = account["email"]
        
        # Print progress explicitly when not using tqdm
        if is_subprocess:
            print(f"Processing account {i+1}/{total}: {email}")
        
        # Step 1: Patch account settings using V2 API
        v2_result = patch_account(v2_api_key, email)
        if v2_result:
            v2_success_count += 1
            print(f"SUCCESS: Successfully patched account settings for {email}")
        else:
            print(f"ERROR: Failed to patch account settings for {email}")
        
        # Step 2: Enable warmup using V1 API
        v1_result = enable_warmup(v1_api_key, email)
        if v1_result:
            v1_success_count += 1
            print(f"SUCCESS: Successfully enabled warmup for {email}")
        else:
            print(f"ERROR: Failed to enable warmup for {email}")
            
        # Add this at the end of the loop:
        # Force output to be displayed immediately
        sys.stdout.flush()
    
    print(f"\nDomain processing complete for {domain}:")
    print(f"- Found {total} accounts")
    print(f"- Successfully patched {v2_success_count}/{total} accounts (V2 API)")
    print(f"- Successfully enabled warmup for {v1_success_count}/{total} accounts (V1 API)")
    
    return v2_success_count, v1_success_count, total

def main():
    # Check if running as a script with arguments
    if len(sys.argv) > 3:
        # Called with arguments: v1_api_key, v2_api_key, and domain
        v1_api_key = sys.argv[1]
        v2_api_key = sys.argv[2]
        domain = sys.argv[3]
        # Detect if we're running as a subprocess and adjust output accordingly
        is_subprocess = not sys.stdin.isatty()
        show_progress = not is_subprocess
        process_domain(v1_api_key, v2_api_key, domain, show_progress)
    else:
        # Interactive mode
        print("Instantly.ai Account Manager")
        print("===========================")
        
        v1_api_key = input("Enter V1 API key: ")
        if not v1_api_key:
            print("V1 API key is required.")
            return
        
        v2_api_key = input("Enter V2 API key: ")
        if not v2_api_key:
            print("V2 API key is required.")
            return
        
        domain = input("Enter domain to process (e.g., example.com): ")
        if not domain:
            print("Domain is required.")
            return
        
        confirmation = input(f"Do you want to process all accounts for {domain}? (y/n): ")
        if confirmation.lower() != 'y':
            print("Operation canceled.")
            return
        
        # Detect if we're running as a subprocess and adjust output accordingly
        is_subprocess = not sys.stdin.isatty()
        show_progress = not is_subprocess
        process_domain(v1_api_key, v2_api_key, domain, show_progress)

if __name__ == "__main__":
    main()
