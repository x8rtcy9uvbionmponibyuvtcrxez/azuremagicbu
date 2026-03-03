import requests
import time
import random
import sys
import csv
import re

def generate_random_warmup_key_id():
    characters = 'abcdefghijklmnopqrstuvwxyz0123456789'
    warmup_key_id = ''.join(random.choice(characters) for _ in range(5))
    return warmup_key_id

def fetch_email_accounts(api_key, target_domain):
    base_url = "https://server.smartlead.ai/api/v1/email-accounts/"
    params = {
        "api_key": api_key,
        "offset": 0,
        "limit": 100
    }
    
    filtered_ids = []
    try:
        while True:
            try:
                print(f"Fetching accounts (offset: {params['offset']})...", flush=True)
                response = requests.get(base_url, params=params, timeout=30)  # Add 30-second timeout
                response.raise_for_status()
                data = response.json()
                
                if not data:
                    break
                
                print(f"Found {len(data)} accounts in this batch", flush=True)
                
                for item in data:
                    if target_domain in item.get('from_email', ''):
                        filtered_ids.append(item['id'])
                
                print(f"Filtered {len(filtered_ids)} accounts for domain {target_domain} so far", flush=True)
                
                if len(data) < params["limit"]:
                    break
                
                params["offset"] += params["limit"]
                
            except requests.exceptions.Timeout:
                print(f"Request timed out. Retrying after a short delay...", flush=True)
                time.sleep(5)
                continue
            except requests.exceptions.RequestException as e:
                print(f"API request error: {e}", flush=True)
                raise
    except Exception as e:
        print(f"Error during account fetching: {e}", flush=True)
        raise
    
    print(f"Total accounts found for {target_domain}: {len(filtered_ids)}", flush=True)
    return filtered_ids

def update_warmup_settings(api_key, id_):
    url = f"https://server.smartlead.ai/api/v1/email-accounts/{id_}/warmup?api_key={api_key}"
    headers = {"Content-Type": "application/json"}
    payload = {
        "warmup_enabled": True,
        "total_warmup_per_day": 5,
        "reply_rate_percentage": 30
    }
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=30)  # Add 30-second timeout
        return response.status_code == 200
    except Exception as e:
        print(f"Error updating warmup settings for {id_}: {e}", flush=True)
        return False

def update_sending_limits(api_key, id_):
    url = f"https://server.smartlead.ai/api/v1/email-accounts/{id_}?api_key={api_key}"
    headers = {"Content-Type": "application/json"}
    payload = {
        "max_email_per_day": 5,
        "time_to_wait_in_mins": 61
    }
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=30)  # Add 30-second timeout
        return response.status_code == 200
    except Exception as e:
        print(f"Error updating sending limits for {id_}: {e}", flush=True)
        return False

def extract_domains_from_csv(csv_path):
    """Extract all unique domains from the EmailAddress column in a CSV file."""
    domains = set()
    try:
        with open(csv_path, newline='', mode='r') as f:
            reader = csv.DictReader(f)
            for row in reader:
                email = row.get('EmailAddress', '')
                if email and '@' in email:
                    # Extract domain portion (after @)
                    domain = email.split('@')[1].strip()
                    if domain:
                        domains.add(domain)
    except Exception as e:
        print(f"Error reading CSV file: {e}", flush=True)
    
    return list(domains)

def process_domain(api_key, target_domain, progress_cb=None):
    """Process a single domain - setting up warmup and sending limits."""
    print(f"\n{'='*40}", flush=True)
    print(f"Processing domain: {target_domain}", flush=True)
    print(f"{'='*40}", flush=True)
    
    print(f"Fetching email accounts for domain {target_domain}...", flush=True)
    try:
        filtered_ids = fetch_email_accounts(api_key, target_domain)

        if not filtered_ids:
            print(f"No email accounts found for the domain {target_domain}.", flush=True)
            return

        successful_warmup_updates = 0
        successful_sending_limit_updates = 0
        total_accounts = len(filtered_ids)
        processed = 0
        
        # Report initial progress
        if progress_cb:
            progress_cb(processed, total_accounts)

        for id_ in filtered_ids:
            # Print progress message to replace tqdm
            print(f"Processing account {processed+1}/{total_accounts}: {id_}", flush=True)
            if update_warmup_settings(api_key, id_):
                successful_warmup_updates += 1
            if update_sending_limits(api_key, id_):
                successful_sending_limit_updates += 1
                
            # Update progress after each account
            processed += 1
            if progress_cb:
                progress_cb(processed, total_accounts)
                
            time.sleep(2)

        print(f"\nTotal successful warmup updates: {successful_warmup_updates}/{total_accounts}", flush=True)
        print(f"Total successful sending limit updates: {successful_sending_limit_updates}/{total_accounts}", flush=True)
        print("Completed processing domain!", flush=True)
    except Exception as e:
        print(f"An error occurred while processing domain {target_domain}: {e}", flush=True)

def main(progress_cb=None):
    # Check if arguments are provided (different modes)
    if len(sys.argv) >= 3:
        api_key = sys.argv[1]
        
        # Check if second argument is a CSV file or a domain
        if sys.argv[2].endswith('.csv'):
            # CSV mode - extract all domains and process each
            csv_path = sys.argv[2]
            domains = extract_domains_from_csv(csv_path)
            
            if not domains:
                print(f"No valid email domains found in the CSV file.", flush=True)
                return
                
            print(f"Found {len(domains)} unique domains in CSV: {', '.join(domains)}", flush=True)
            
            # Track total domains for progress
            total_domains = len(domains)
            domains_processed = 0
            
            # Process each domain
            for domain in domains:
                print(f"Processing domain {domains_processed+1}/{total_domains}: {domain}", flush=True)
                process_domain(api_key, domain, progress_cb)
                domains_processed += 1
                # Short pause between domains
                time.sleep(2)
                
            return
        else:
            # Single domain mode
            target_domain = sys.argv[2]
            process_domain(api_key, target_domain, progress_cb)
    else:
        # Fallback to interactive mode
        api_key = input("Please enter your API key: ").strip()
        mode = input("Enter 'csv' to process a CSV file or 'domain' for a single domain: ").strip().lower()
        
        if mode == 'csv':
            csv_path = input("Enter path to the CSV file: ").strip()
            domains = extract_domains_from_csv(csv_path)
            
            if not domains:
                print(f"No valid email domains found in the CSV file.", flush=True)
                return
                
            print(f"Found {len(domains)} unique domains in CSV: {', '.join(domains)}", flush=True)
            
            # Track total domains for progress
            total_domains = len(domains)
            domains_processed = 0
            
            # Process each domain
            for domain in domains:
                print(f"Processing domain {domains_processed+1}/{total_domains}: {domain}", flush=True)
                process_domain(api_key, domain, progress_cb)
                domains_processed += 1
                # Short pause between domains
                time.sleep(2)
        else:
            target_domain = input("Please enter the target email domain (e.g., example.com): ").strip()
            process_domain(api_key, target_domain, progress_cb)

if __name__ == "__main__":
    main()
