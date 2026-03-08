import sys
import requests
import csv
import time
import os
from datetime import datetime
from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.by import By
from colorama import Fore, Style, init


def fetch_email_accounts(api_key, max_accounts=9999):
    base_url = "https://server.smartlead.ai/api/v1/email-accounts/"
    accounts = []
    offset = 0
    limit = 100
    while True:
        api_url = f"{base_url}?api_key={api_key}&offset={offset}&limit={limit}"
        try:
            response = requests.get(api_url)
            if response.status_code == 200:
                data = response.json()
                if offset == 0:
                    sample_email = data[0]['from_email'] if data else 'No data'
                    print(f"{Fore.GREEN}Connected. Sample: {sample_email}{Style.RESET_ALL}")
                accounts.extend(data)
                if len(data) < limit or len(accounts) >= max_accounts:
                    break
                offset += limit
            else:
                print(f"{Fore.RED}Error: status {response.status_code}{Style.RESET_ALL}")
                print(f"{Fore.YELLOW}{response.text}{Style.RESET_ALL}")
                break
        except requests.exceptions.RequestException as e:
            print(f"{Fore.RED}Request error: {e}{Style.RESET_ALL}")
            break
    return [acct['from_email'] for acct in accounts]


def check_email_added(api_key, email):
    base_url = "https://server.smartlead.ai/api/v1/email-accounts/"
    api_url = f"{base_url}?api_key={api_key}&offset=0&limit=100"
    try:
        resp = requests.get(api_url)
        if resp.status_code == 200:
            data = resp.json()
            return email in [acct['from_email'] for acct in data]
        else:
            print(f"{Fore.RED}Check error: status {resp.status_code}{Style.RESET_ALL}")
            return False
    except requests.exceptions.RequestException as e:
        print(f"{Fore.RED}Check request error: {e}{Style.RESET_ALL}")
        return False


def process_emails(api_key, csv_path, custom_login_url, progress_cb=None, log_cb=None, failed_cb=None):
    """
    Processes each email in the CSV, reports progress via progress_cb(current, total).
    If log_cb is provided, it will be called with status messages.
    If failed_cb is provided, it will be called with (current_failed, total) for failed accounts.
    Returns path to CSV with failed accounts, or None if no failures.
    """
    init()
    # Configure logging for both stdout and callback
    def log_message(msg):
        print(msg)  # Always print to console
        if log_cb:  # Also send to callback if available
            try:
                log_cb(msg)
            except Exception as e:
                print(f"Error in log callback: {e}")
    try:
        log_message("Starting to fetch existing email accounts...")
        existing = fetch_email_accounts(api_key)
        log_message("Finished fetching existing accounts")
        # Read CSV file
        log_message(f"Reading CSV file: {csv_path}")
        emails_passwords = []
        csv_fieldnames = []
        try:
            with open(csv_path, newline='', mode='r') as f:
                reader = csv.DictReader(f)
                csv_fieldnames = reader.fieldnames  # Store field names for failed accounts CSV
                for row in reader:
                    # Store the complete row for use with failed accounts
                    account_data = {'email': row['EmailAddress'], 'password': row['Password'], 'original_row': row}
                    emails_passwords.append(account_data)
        except Exception as e:
            log_message(f"Error reading CSV: {e}")
            raise
            
        total = len(emails_passwords)
        log_message(f"Total email addresses to process: {total}")
        processed = 0
        failed_accounts = []  # Track failed accounts
        max_retries = 4

        for rec in emails_passwords:
            email = rec['email']
            password = rec['password']
            attempts = 0

            if email in existing:
                processed += 1
                log_message(f"Account {email} already exists in Smartlead, skipping ({processed}/{total})")
                if progress_cb:
                    progress_cb(processed, total)
                continue

            while attempts < max_retries:
                # log each attempt
                log_message(f"Processing account {email}: attempt {attempts+1}/{max_retries}")
                try:
                    opts = webdriver.ChromeOptions()
                    opts.add_argument("--headless")
                    driver = webdriver.Chrome(options=opts)

                    log_message(f"Opening login URL for {email}")
                    driver.get(custom_login_url)
                    time.sleep(5)

                    # login username
                    log_message(f"Entering username for {email}")
                    oauth_user = driver.find_element(By.NAME, 'loginfmt')
                    oauth_user.send_keys(email)
                    log_message(f"Clicking submit for username")
                    driver.find_element(By.CSS_SELECTOR, 'input[type="submit"]').click()
                    time.sleep(5)

                    # login password
                    log_message(f"Entering password for {email}")
                    oauth_pass = driver.find_element(By.NAME, 'passwd')
                    oauth_pass.send_keys(password)
                    log_message(f"Clicking submit for password")
                    driver.find_element(By.CSS_SELECTOR, 'input[type="submit"]').click()
                    time.sleep(5)

                    # handle optional popups
                    try:
                        log_message(f"Checking for 'Stay signed in' dialog")
                        wait = WebDriverWait(driver, 3)
                        btn = wait.until(EC.element_to_be_clickable((By.ID, 'KmsiCheckboxField')))
                        log_message(f"Clicking 'Stay signed in' checkbox")
                        btn.click()
                        btn = wait.until(EC.element_to_be_clickable((By.ID, 'idBtn_Back')))
                        log_message(f"Clicking 'Yes' button")
                        btn.click()
                    except TimeoutException:
                        log_message(f"No 'Stay signed in' dialog found")
                        pass
                    time.sleep(5)

                    try:
                        log_message(f"Checking for 'Ask me later' button")
                        wait = WebDriverWait(driver, 3)
                        wait.until(EC.element_to_be_clickable((By.ID, 'btnAskLater'))).click()
                        log_message(f"Clicked 'Ask me later' button")
                    except TimeoutException:
                        log_message(f"No 'Ask me later' button found")
                        pass
                    time.sleep(5)

                    try:
                        log_message(f"Checking for additional submit button")
                        WebDriverWait(driver, 3).until(
                            EC.element_to_be_clickable((By.CSS_SELECTOR, 'input[type="submit"]'))
                        ).click()
                        log_message(f"Clicked additional submit button")
                    except TimeoutException:
                        log_message(f"No additional submit button found")
                        pass
                    time.sleep(2)

                    log_message(f"Checking if {email} was added to Smartlead")
                    if check_email_added(api_key, email):
                        processed += 1
                        log_message(f"SUCCESS: Email {email} added successfully ({processed}/{total})")
                        if progress_cb:
                            progress_cb(processed, total)
                        break
                    else:
                        attempts += 1
                        log_message(f"Email {email} not added, retrying... (attempt {attempts}/{max_retries})")
                        time.sleep(2)
                except Exception as e:
                    attempts += 1
                    log_message(f"ERROR processing {email} on attempt {attempts}: {str(e)}")
                    time.sleep(2)
                finally:
                    try:
                        driver.quit()
                    except:
                        pass

            if attempts == max_retries:
                processed += 1
                log_message(f"Max retries reached for {email}, moving to next ({processed}/{total})")
                # Add to failed accounts list with all original columns
                # Find the original row data
                original_row = None
                for account in emails_passwords:
                    if account['email'] == email:
                        original_row = account['original_row']
                        break
                        
                # Make sure we have at least the email and password
                if not original_row:
                    original_row = {'EmailAddress': email, 'Password': password}
                    
                failed_accounts.append(original_row)
                if failed_cb:
                    failed_cb(len(failed_accounts), total)
                if progress_cb:
                    progress_cb(processed, total)
    finally:
        if 'processed' in locals():
            log_message(f"Processing complete. Processed {processed} accounts.")
            
            # Save failed accounts to CSV if there are any
            if 'failed_accounts' in locals() and failed_accounts:
                # Use underscore instead of space in timestamp to avoid file system issues
                timestamp = datetime.now().strftime('%m-%d-%Y_%H-%M')
                failed_csv_path = f"failed_accounts_{timestamp}.csv"
                log_message(f"Attempting to save {len(failed_accounts)} failed accounts to {failed_csv_path}")
                
                try:
                    # Debug the failed accounts data
                    for i, account in enumerate(failed_accounts):
                        log_message(f"Failed account {i+1}: {account}")
                    
                    # Make sure path is in current directory
                    current_dir = os.getcwd()
                    full_path = os.path.join(current_dir, failed_csv_path)
                    log_message(f"Saving to full path: {full_path}")
                    
                    with open(full_path, 'w', newline='') as csvfile:
                        # Use the original CSV fieldnames to maintain all columns
                        writer = csv.DictWriter(csvfile, fieldnames=csv_fieldnames)
                        writer.writeheader()
                        for account in failed_accounts:
                            writer.writerow(account)
                            
                    # Verify file exists and has content
                    if os.path.exists(full_path):
                        file_size = os.path.getsize(full_path)
                        log_message(f"CSV created successfully. File size: {file_size} bytes")
                        if file_size > 0:
                            log_message(f"SUCCESS: Saved {len(failed_accounts)} failed accounts to {failed_csv_path}")
                            return full_path
                        else:
                            log_message(f"WARNING: CSV file was created but appears to be empty")
                    else:
                        log_message(f"WARNING: Failed to create CSV file at {full_path}")
                except Exception as e:
                    log_message(f"ERROR saving failed accounts to CSV: {str(e)}")
            else:
                log_message("No failed accounts to save.")
                return None


# CLI entrypoint
if __name__ == '__main__':
    init()
    api_key = sys.argv[1]
    csv_path = sys.argv[2]
    login_url = sys.argv[3]
    process_emails(api_key, csv_path, login_url)
