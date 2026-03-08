#!/usr/bin/env python3
import sys
import requests
import csv
import time
import os
import random
from datetime import datetime
from selenium import webdriver
from selenium.common.exceptions import TimeoutException, NoSuchElementException, WebDriverException
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.by import By
from colorama import Fore, Style, init
from config import MAX_RETRIES_PER_ACCOUNT

def fetch_existing_accounts_v1(api_key, max_accounts=999999):
    """Fetch existing email accounts from Instantly V1 API with pagination"""
    base_url = "https://api.instantly.ai/api/v1/account/list"
    all_accounts = []
    skip = 0
    limit = 100  # API limit per request
    
    try:
        while len(all_accounts) < max_accounts:
            params = {
                'api_key': api_key,
                'limit': limit,
                'skip': skip
            }
            
            response = requests.get(base_url, params=params)
            if response.status_code == 200:
                data = response.json()
                # Handle the response format with 'accounts' key
                if isinstance(data, dict) and 'accounts' in data:
                    account_list = data['accounts']
                    if not account_list:  # No more accounts
                        break
                    
                    emails = [acc.get('email', '') for acc in account_list if acc.get('email')]
                    all_accounts.extend(emails)
                    
                    # If we got less than limit, we've reached the end
                    if len(account_list) < limit:
                        break
                    
                    skip += limit
                elif isinstance(data, list):
                    # Fallback for direct list response
                    if not data:  # No more accounts
                        break
                    
                    emails = [acc.get('email', '') for acc in data if acc.get('email')]
                    all_accounts.extend(emails)
                    
                    if len(data) < limit:
                        break
                    
                    skip += limit
                else:
                    print(f"Unexpected API response format: {type(data)}")
                    print(f"Response preview: {str(data)[:200]}...")
                    break
            else:
                print(f"API Error: Status {response.status_code}")
                print(f"Response: {response.text[:500]}...")
                break
                
        print(f"Found {len(all_accounts)} total existing accounts in Instantly")
    except requests.exceptions.RequestException as e:
        print(f"Request error: {e}")
    except Exception as e:
        print(f"Error fetching accounts: {e}")
    
    return all_accounts

def fetch_existing_accounts_v2(api_key, max_accounts=999999):
    """Fetch existing email accounts from Instantly V2 API with cursor-based pagination"""
    base_url = "https://api.instantly.ai/api/v2/accounts"
    all_accounts = []
    limit = 100  # API limit per request
    starting_after = None
    batch_count = 0
    
    try:
        print("V2 API: Starting to fetch existing accounts...")
        
        while len(all_accounts) < max_accounts:
            batch_count += 1
            params = {
                'limit': limit
            }
            
            # Use cursor-based pagination with starting_after
            if starting_after:
                params['starting_after'] = starting_after
            
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }
            
            print(f"V2 API: Fetching batch {batch_count} (limit={limit}, starting_after={starting_after})")
            response = requests.get(base_url, headers=headers, params=params)
            
            if response.status_code == 200:
                data = response.json()
                
                # Handle the V2 response format with 'items' key
                if isinstance(data, dict) and 'items' in data:
                    account_list = data['items']
                    print(f"V2 API: Retrieved {len(account_list)} accounts in this batch")
                    
                    if not account_list:  # No more accounts
                        print("V2 API: No more accounts to fetch (empty items)")
                        break
                    
                    emails = [acc.get('email', '') for acc in account_list if acc.get('email')]
                    all_accounts.extend(emails)
                    print(f"V2 API: Added {len(emails)} emails to collection. Total so far: {len(all_accounts)}")
                    
                    # Check for next_starting_after to continue pagination
                    next_starting_after = data.get('next_starting_after')
                    if next_starting_after and next_starting_after != starting_after:
                        starting_after = next_starting_after
                        print(f"V2 API: Next cursor: {starting_after}")
                    else:
                        print("V2 API: No more pages (no next_starting_after or same cursor)")
                        break
                    
                    # If we got less than limit, we've likely reached the end
                    if len(account_list) < limit:
                        print(f"V2 API: Reached end of accounts (got {len(account_list)} < {limit})")
                        break
                        
                else:
                    print(f"Unexpected V2 API response format: {type(data)}")
                    print(f"Response preview: {str(data)[:200]}...")
                    break
            else:
                print(f"V2 API Error: Status {response.status_code}")
                print(f"Response: {response.text[:500]}...")
                break
                
        print(f"V2 API: Found {len(all_accounts)} total existing accounts in Instantly")
    except requests.exceptions.RequestException as e:
        print(f"V2 API Request error: {e}")
    except Exception as e:
        print(f"V2 API Error fetching accounts: {e}")
    
    return all_accounts

def fetch_existing_accounts(api_key, api_version="v1", max_accounts=9999):
    """Fetch existing accounts using the specified API version"""
    if api_version == "v2":
        return fetch_existing_accounts_v2(api_key, max_accounts)
    else:
        return fetch_existing_accounts_v1(api_key, max_accounts)

def check_email_added_v1(api_key, email, worker_id=""):
    """Check if a specific email account was successfully added to Instantly using V1 API"""
    prefix = f"Worker {worker_id}: " if worker_id else ""
    base_url = "https://api.instantly.ai/api/v1/account/list"
    
    try:
        print(f"{prefix}Checking if {email} was successfully added to Instantly (V1)...")
        
        params = {
            'api_key': api_key,
            'limit': 10,
            'skip': 0
        }
        
        response = requests.get(base_url, params=params)
        if response.status_code == 200:
            data = response.json()
            
            # Handle the response format with 'accounts' key
            if isinstance(data, dict) and 'accounts' in data:
                account_list = data['accounts']
                # Check if our email is in the returned accounts
                for acc in account_list:
                    if acc.get('email', '').lower() == email.lower():
                        print(f"{Fore.GREEN}{prefix}SUCCESS: Email {email} found in Instantly{Style.RESET_ALL}")
                        return True
                        
                print(f"{Fore.YELLOW}{prefix}NOT FOUND: Email {email} not found in Instantly{Style.RESET_ALL}")
                return False
                
            elif isinstance(data, list):
                # Fallback for direct list response
                for acc in data:
                    if acc.get('email', '').lower() == email.lower():
                        print(f"{Fore.GREEN}{prefix}SUCCESS: Email {email} found in Instantly{Style.RESET_ALL}")
                        return True
                        
                print(f"{Fore.YELLOW}{prefix}NOT FOUND: Email {email} not found in Instantly{Style.RESET_ALL}")
                return False
            else:
                print(f"{Fore.RED}{prefix}Unexpected API response format for email check{Style.RESET_ALL}")
                return False
        else:
            print(f"{Fore.RED}{prefix}API Error checking email: Status {response.status_code}{Style.RESET_ALL}")
            return False
            
    except requests.exceptions.RequestException as e:
        print(f"{Fore.RED}{prefix}Request error checking email: {e}{Style.RESET_ALL}")
        return False
    except Exception as e:
        print(f"{Fore.RED}{prefix}Error checking email: {e}{Style.RESET_ALL}")
        return False

def check_email_added_v2(api_key, email, worker_id=""):
    """Check if a specific email account was successfully added to Instantly using V2 API"""
    prefix = f"Worker {worker_id}: " if worker_id else ""
    base_url = "https://api.instantly.ai/api/v2/accounts"
    
    try:
        print(f"{prefix}Checking if {email} was successfully added to Instantly (V2)...")
        
        # Use cursor-based pagination to check accounts
        all_accounts = []
        limit = 100
        starting_after = None
        max_checks = 500  # Check up to 500 accounts
        batch_count = 0
        
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        while len(all_accounts) < max_checks:
            batch_count += 1
            params = {
                'limit': limit
            }
            
            if starting_after:
                params['starting_after'] = starting_after
            
            print(f"{prefix}V2 API: Fetching accounts batch {batch_count} (limit={limit}, starting_after={starting_after})")
            response = requests.get(base_url, headers=headers, params=params)
            
            if response.status_code == 200:
                data = response.json()
                print(f"{prefix}V2 API Response keys: {list(data.keys()) if isinstance(data, dict) else 'Not a dict'}")
                
                # Handle the V2 response format with 'items' key
                if isinstance(data, dict) and 'items' in data:
                    account_list = data['items']
                    print(f"{prefix}V2 API: Retrieved {len(account_list)} accounts in this batch")
                    
                    if not account_list:  # No more accounts
                        print(f"{prefix}V2 API: No more accounts to fetch (empty items)")
                        break
                    
                    all_accounts.extend(account_list)
                    
                    # Check accounts in this batch
                    for i, acc in enumerate(account_list):
                        acc_email = acc.get('email', '')
                        if acc_email.lower() == email.lower():
                            print(f"{Fore.GREEN}{prefix}SUCCESS: Email {email} found in Instantly (V2 API){Style.RESET_ALL}")
                            return True
                    
                    # Check for next_starting_after to continue pagination
                    next_starting_after = data.get('next_starting_after')
                    if next_starting_after and next_starting_after != starting_after:
                        starting_after = next_starting_after
                        print(f"{prefix}V2 API: Next cursor: {starting_after}")
                    else:
                        print(f"{prefix}V2 API: No more pages (no next_starting_after or same cursor)")
                        break
                    
                    # If we got less than limit, we've likely reached the end
                    if len(account_list) < limit:
                        print(f"{prefix}V2 API: Reached end of accounts (got {len(account_list)} < {limit})")
                        break
                        
                else:
                    print(f"{Fore.RED}{prefix}Unexpected V2 API response format for email check{Style.RESET_ALL}")
                    print(f"{prefix}Response data: {str(data)[:500]}...")
                    return False
            else:
                print(f"{Fore.RED}{prefix}V2 API Error checking email: Status {response.status_code}{Style.RESET_ALL}")
                print(f"{prefix}Response text: {response.text[:500]}...")
                return False
        
        print(f"{prefix}V2 API: Checked {len(all_accounts)} total accounts")
        print(f"{Fore.YELLOW}{prefix}NOT FOUND: Email {email} not found in {len(all_accounts)} accounts (V2 API){Style.RESET_ALL}")
        return False
            
    except requests.exceptions.RequestException as e:
        print(f"{Fore.RED}{prefix}Request error checking email: {e}{Style.RESET_ALL}")
        return False
    except Exception as e:
        print(f"{Fore.RED}{prefix}Error checking email: {e}{Style.RESET_ALL}")
        return False

def check_email_added(api_key, email, worker_id="", api_version="v1"):
    """Check if a specific email account was successfully added to Instantly"""
    if api_version == "v2":
        return check_email_added_v2(api_key, email, worker_id)
    else:
        return check_email_added_v1(api_key, email, worker_id)

def setup_driver():
    """Setup Chrome driver with incognito mode and optimized settings.

    Automatically detects container environments (via CHROME_BIN env var)
    and applies memory-safe flags to prevent tab crashes.
    """
    chrome_options = webdriver.ChromeOptions()
    chrome_options.add_argument("--incognito")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--disable-popup-blocking")
    chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])
    chrome_options.add_experimental_option('useAutomationExtension', False)

    # Detect container / Railway environment
    in_container = bool(os.environ.get("CHROME_BIN"))

    if in_container:
        chrome_options.add_argument("--headless=new")
        chrome_options.add_argument("--window-size=1920,1080")
        # Memory-saving flags critical for Railway / Docker containers
        chrome_options.add_argument("--disable-extensions")
        chrome_options.add_argument("--disable-software-rasterizer")
        chrome_options.add_argument("--disable-background-networking")
        chrome_options.add_argument("--disable-default-apps")
        chrome_options.add_argument("--disable-sync")
        chrome_options.add_argument("--disable-translate")
        chrome_options.add_argument("--no-first-run")
        chrome_options.add_argument("--single-process")
        chrome_options.add_argument("--crash-dumps-dir=/tmp")
        chrome_options.add_argument("--disable-crash-reporter")
        # Use the container's Chromium binary
        chrome_options.binary_location = os.environ["CHROME_BIN"]

    try:
        driver = webdriver.Chrome(options=chrome_options)
        driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        if not in_container:
            driver.maximize_window()
        return driver
    except Exception as e:
        print(f"Failed to setup Chrome driver: {e}")
        return None

def switch_workspace(driver, target_workspace, worker_id=""):
    """Switch to the specified workspace if not already selected"""
    prefix = f"Worker {worker_id}: " if worker_id else ""
    
    if not target_workspace:
        print(f"{prefix}No workspace specified, continuing with current workspace")
        return True
    
    try:
        print(f"{prefix}Checking current workspace...")
        
        # Wait for page to load completely and workspace button to appear
        print(f"{prefix}Waiting for page to fully load...")
        time.sleep(5)
        
        # Multiple selector strategies for finding the workspace button
        workspace_button = None
        selectors = [
            "//button[contains(@class, 'MuiButton-root') and contains(@class, 'MuiButton-outlined')]//div[contains(@class, 'MuiGrid-item')]",
            "//button[contains(@class, 'MuiButton-root')]//div[contains(@class, 'MuiGrid-item')][1]",
            "//div[@class='AppTopbar__ContentContainer-sc-7gcyed-0 kqmvQN']//button[contains(@class, 'MuiButton-root')]",
            "//*[@id='mainAppBar']//button[contains(@class, 'MuiButton-root')]",
            "//button[contains(@class, 'MuiButton-root') and .//div[contains(text(), 'My Organizatio') or contains(text(), 'SalFlow')]]",
            "/html/body/div[1]/div[2]/div[1]/div[1]/div/div/button[2]",
            "//button[contains(@class, 'cursorPointer') and contains(@class, 'MuiButton')]"
        ]
        
        for i, selector in enumerate(selectors):
            try:
                print(f"{prefix}Trying selector {i+1}: {selector}")
                workspace_button = WebDriverWait(driver, 5).until(
                    EC.element_to_be_clickable((By.XPATH, selector))
                )
                print(f"{prefix}Found workspace button with selector {i+1}")
                break
            except TimeoutException:
                print(f"{prefix}Selector {i+1} failed")
                continue
        
        if not workspace_button:
            print(f"{prefix}Could not find workspace button with any selector")
            # Take a screenshot for debugging
            driver.save_screenshot(f"workspace_debug_{worker_id}.png")
            print(f"{prefix}Screenshot saved as workspace_debug_{worker_id}.png")
            return False
        
        # Extract workspace text from the button - try multiple methods
        current_workspace = ""
        try:
            # Try to find the text in the MuiGrid-item div inside the button
            workspace_text_element = workspace_button.find_element(By.XPATH, ".//div[contains(@class, 'MuiGrid-item')][1]")
            current_workspace = workspace_text_element.text.strip()
        except:
            # Fallback to button text
            current_workspace = workspace_button.text.strip()
        
        # Handle truncated workspace names (e.g., "My Organizatio...")
        if current_workspace.endswith("..."):
            current_workspace = current_workspace[:-3]  # Remove the ellipsis
        
        print(f"{prefix}Current workspace: '{current_workspace}'")
        print(f"{prefix}Target workspace: '{target_workspace}'")
        
        # Check if workspaces match (handle truncated names)
        if current_workspace.lower() == target_workspace.lower() or \
           target_workspace.lower().startswith(current_workspace.lower()) or \
           current_workspace.lower().startswith(target_workspace.lower()):
            print(f"{Fore.GREEN}{prefix}Already in correct workspace: {current_workspace}{Style.RESET_ALL}")
            return True
        
        print(f"{prefix}Need to switch from '{current_workspace}' to '{target_workspace}'")
        
        # Click the workspace dropdown button
        print(f"{prefix}Clicking workspace dropdown...")
        driver.execute_script("arguments[0].click();", workspace_button)
        time.sleep(3)
        
        # Find and click the target workspace option with multiple strategies
        workspace_option = None
        dropdown_selectors = [
            f"//div[contains(@class, 'MuiPaper-root')]//li[contains(text(), '{target_workspace}')]",
            f"//div[contains(@class, 'MuiMenu-paper')]//li[contains(text(), '{target_workspace}')]",
            f"//ul[contains(@class, 'MuiMenu-list')]//li[contains(text(), '{target_workspace}')]",
            f"//div[contains(@class, 'MuiPopper-root')]//li[contains(text(), '{target_workspace}')]",
            f"//li[contains(@class, 'MuiMenuItem-root') and contains(text(), '{target_workspace}')]",
            f"//div[@role='menu']//li[contains(text(), '{target_workspace}')]",
            f"//li[@role='menuitem' and contains(text(), '{target_workspace}')]",
            f"//*[contains(text(), '{target_workspace}') and (contains(@class, 'MuiMenuItem') or parent::li[contains(@class, 'MuiMenuItem')])]"
        ]
        
        print(f"{prefix}Looking for workspace option: {target_workspace}")
        for i, selector in enumerate(dropdown_selectors):
            try:
                print(f"{prefix}Trying dropdown selector {i+1}: {selector}")
                workspace_option = WebDriverWait(driver, 3).until(
                    EC.element_to_be_clickable((By.XPATH, selector))
                )
                print(f"{prefix}Found workspace option with selector {i+1}")
                break
            except TimeoutException:
                print(f"{prefix}Dropdown selector {i+1} failed")
                continue
        
        if not workspace_option:
            print(f"{prefix}Could not find workspace option: {target_workspace}")
            # Take a screenshot for debugging
            driver.save_screenshot(f"workspace_dropdown_debug_{worker_id}.png")
            print(f"{prefix}Dropdown screenshot saved as workspace_dropdown_debug_{worker_id}.png")
            return False
        
        print(f"{prefix}Clicking on workspace: {target_workspace}")
        driver.execute_script("arguments[0].click();", workspace_option)
        time.sleep(5)
        
        # Verify the workspace switch was successful
        try:
            for selector in selectors:
                try:
                    updated_button = WebDriverWait(driver, 3).until(
                        EC.element_to_be_clickable((By.XPATH, selector))
                    )
                    
                    # Extract workspace text from the button
                    updated_workspace = ""
                    try:
                        workspace_text_element = updated_button.find_element(By.XPATH, ".//div[contains(@class, 'MuiGrid-item')][1]")
                        updated_workspace = workspace_text_element.text.strip()
                    except:
                        updated_workspace = updated_button.text.strip()
                    
                    # Handle truncated workspace names
                    if updated_workspace.endswith("..."):
                        updated_workspace = updated_workspace[:-3]
                    
                    # Check if workspaces match (handle truncated names)
                    if updated_workspace.lower() == target_workspace.lower() or \
                       target_workspace.lower().startswith(updated_workspace.lower()) or \
                       updated_workspace.lower().startswith(target_workspace.lower()):
                        print(f"{Fore.GREEN}{prefix}Successfully switched to workspace: {updated_workspace}{Style.RESET_ALL}")
                        return True
                    else:
                        print(f"{prefix}Current workspace after switch: '{updated_workspace}', Expected: '{target_workspace}'")
                    break
                except TimeoutException:
                    continue
            
            print(f"{Fore.YELLOW}{prefix}Workspace switch may not have completed{Style.RESET_ALL}")
            return False
            
        except Exception as e:
            print(f"{Fore.YELLOW}{prefix}Could not verify workspace switch: {e}{Style.RESET_ALL}")
            return False
        
    except TimeoutException:
        print(f"{Fore.RED}{prefix}Timeout while switching workspace{Style.RESET_ALL}")
        driver.save_screenshot(f"workspace_timeout_debug_{worker_id}.png")
        print(f"{prefix}Timeout screenshot saved as workspace_timeout_debug_{worker_id}.png")
        return False
    except Exception as e:
        print(f"{Fore.RED}{prefix}Error switching workspace: {e}{Style.RESET_ALL}")
        driver.save_screenshot(f"workspace_error_debug_{worker_id}.png")
        print(f"{prefix}Error screenshot saved as workspace_error_debug_{worker_id}.png")
        return False

def login_to_instantly(driver, email, password, workspace="", worker_id=""):
    """Login to Instantly account using simplified approach from original"""
    prefix = f"Worker {worker_id}: " if worker_id else ""
    
    try:
        print(f"{prefix}Navigating to Instantly accounts page...")
        driver.get("https://app.instantly.ai/app/accounts")
        time.sleep(2)
        
        print(f"{prefix}Waiting for email field...")
        # Enter email
        email_field = WebDriverWait(driver, 10).until(
            EC.visibility_of_element_located((By.XPATH, "//input[@placeholder='Email']"))
        )
        print(f"{prefix}Entering email: {email}")
        email_field.clear()
        email_field.send_keys(email)
        
        print(f"{prefix}Waiting for password field...")
        # Enter password
        password_field = WebDriverWait(driver, 10).until(
            EC.visibility_of_element_located((By.XPATH, "//input[@placeholder='Password']"))
        )
        print(f"{prefix}Entering password...")
        password_field.clear()
        password_field.send_keys(password)
        
        print(f"{prefix}Clicking login button...")
        # Click login button
        WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable((By.XPATH, "//button[@type='submit']"))
        ).click()
        
        print(f"{prefix}Waiting for login success...")
        # Wait for login success - check URL is app/accounts
        WebDriverWait(driver, 15).until(
            lambda driver: "https://app.instantly.ai/app/accounts" in driver.current_url
        )
        
        print(f"{Fore.GREEN}{prefix}Login successful{Style.RESET_ALL}")
        
        # Switch to the specified workspace if provided
        if workspace:
            if not switch_workspace(driver, workspace, worker_id):
                print(f"{Fore.YELLOW}{prefix}WARNING: Failed to switch to workspace: {workspace}{Style.RESET_ALL}")
                print(f"{Fore.YELLOW}{prefix}Continuing without workspace switch...{Style.RESET_ALL}")
                # Continue anyway - don't fail the login
                # return False
        
        return True
        
    except TimeoutException:
        print(f"{Fore.RED}{prefix}Login failed - timeout{Style.RESET_ALL}")
        return False
    except Exception as e:
        print(f"{Fore.RED}{prefix}Login error: {e}{Style.RESET_ALL}")
        return False

def complete_oauth_flow(driver, email, password, worker_id=""):
    """Complete Microsoft OAuth flow"""
    prefix = f"Worker {worker_id}: " if worker_id else ""
    
    try:
        print(f"{prefix}Waiting for email input field...")
        # Wait for email input
        email_input = WebDriverWait(driver, 10).until(
            EC.visibility_of_element_located((By.NAME, 'loginfmt'))
        )
        print(f"{prefix}Entering email: {email}")
        email_input.send_keys(email)
        time.sleep(1)
        
        print(f"{prefix}Clicking Next button...")
        # Click Next
        next_btn = WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, 'input[type="submit"]'))
        )
        next_btn.click()
        time.sleep(2)
        
        print(f"{prefix}Waiting for password input field...")
        # Enter password
        password_input = WebDriverWait(driver, 10).until(
            EC.visibility_of_element_located((By.NAME, 'passwd'))
        )
        print(f"{prefix}Entering password...")
        password_input.send_keys(password)
        time.sleep(1)
        
        print(f"{prefix}Clicking Sign in button...")
        # Click Sign in
        signin_btn = WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, 'input[type="submit"]'))
        )
        signin_btn.click()
        time.sleep(3)
        
        # Handle "Stay signed in?" dialog properly
        try:
            print(f"{prefix}Checking for 'Stay signed in' dialog...")
            wait = WebDriverWait(driver, 3)
            # First check for the checkbox (this is the actual stay signed in dialog)
            checkbox = wait.until(EC.element_to_be_clickable((By.ID, 'KmsiCheckboxField')))
            print(f"{prefix}Found 'Stay signed in' checkbox, clicking it...")
            checkbox.click()
            # Then click the "Yes" button (idBtn_Back is actually "Yes" in this context)
            yes_btn = wait.until(EC.element_to_be_clickable((By.ID, 'idBtn_Back')))
            print(f"{prefix}Clicking 'Yes' button on stay signed in...")
            yes_btn.click()
            time.sleep(2)
        except TimeoutException:
            print(f"{prefix}No 'Stay signed in' dialog found")
            pass
        
        # Handle "Ask me later" or other security prompts
        try:
            print(f"{prefix}Checking for 'Ask me later' button...")
            wait = WebDriverWait(driver, 3)
            ask_later_btn = wait.until(EC.element_to_be_clickable((By.ID, 'btnAskLater')))
            print(f"{prefix}Clicking 'Ask me later' button...")
            ask_later_btn.click()
            time.sleep(2)
        except TimeoutException:
            print(f"{prefix}No 'Ask me later' button found")
            pass
        
        # Handle permissions acceptance (this is the Accept/Deny permissions dialog)
        try:
            print(f"{prefix}Checking for permissions acceptance dialog...")
            wait = WebDriverWait(driver, 3)
            accept_btn = wait.until(EC.element_to_be_clickable((By.XPATH, "//input[@value='Accept']")))
            print(f"{prefix}Accepting permissions...")
            accept_btn.click()
            time.sleep(2)
        except TimeoutException:
            print(f"{prefix}No permissions dialog found")
            pass
        
        print(f"{prefix}Switching back to main window...")
        # Switch back to main window
        all_windows = driver.window_handles
        if len(all_windows) > 1:
            driver.switch_to.window(all_windows[0])
            # Close OAuth window
            if len(driver.window_handles) > 1:
                driver.switch_to.window(all_windows[1])
                driver.close()
                driver.switch_to.window(all_windows[0])
        
        time.sleep(3)
        print(f"{Fore.GREEN}{prefix}OAuth flow completed successfully{Style.RESET_ALL}")
        return True
        
    except Exception as e:
        print(f"{Fore.RED}{prefix}OAuth error: {e}{Style.RESET_ALL}")
        return False

def add_email_account(driver, api_key, instantly_email, instantly_password, workspace, email, password, worker_id="", retries=MAX_RETRIES_PER_ACCOUNT, api_version="v1"):
    """Add a new email account to Instantly with API verification"""
    prefix = f"Worker {worker_id}: " if worker_id else ""
    
    for attempt in range(retries):
        # Setup fresh driver for each retry attempt
        if attempt > 0:
            print(f"{prefix}Closing browser for retry attempt...")
            try:
                driver.quit()
            except:
                pass
            
            print(f"{prefix}Waiting 5 seconds before retry...")
            time.sleep(5)
            
            print(f"{prefix}Setting up fresh browser for retry attempt {attempt + 1}/{retries}...")
            driver = setup_driver()
            if not driver:
                print(f"{Fore.RED}{prefix}Failed to setup driver for retry{Style.RESET_ALL}")
                continue
            
            # Login to Instantly with fresh browser
            print(f"{prefix}Logging into Instantly with fresh browser...")
            if not login_to_instantly(driver, instantly_email, instantly_password, workspace, worker_id):
                print(f"{Fore.RED}{prefix}Failed to login to Instantly on retry{Style.RESET_ALL}")
                continue
        
        try:
            print(f"{prefix}Navigating to accounts page for {email} (attempt {attempt + 1}/{retries})...")
            # Navigate to accounts page
            driver.get("https://app.instantly.ai/app/accounts")
            time.sleep(3)
            
            print(f"{prefix}Looking for 'Add New' button...")
            # Click Add New button
            add_new_btn = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.XPATH, "//button[.//span[text()='Add New']]"))
            )
            print(f"{prefix}Clicking 'Add New' button...")
            add_new_btn.click()
            time.sleep(2)
            
            print(f"{prefix}Looking for Microsoft option...")
            # Click Microsoft option
            microsoft_option = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.XPATH, '//p[text()="Microsoft"]'))
            )
            print(f"{prefix}Clicking Microsoft option...")
            microsoft_option.click()
            time.sleep(2)
            
            print(f"{prefix}Looking for SMTP enabled button...")
            # Click SMTP enabled button
            smtp_btn = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.XPATH, "//button[contains(text(), 'SMTP has been enabled')]"))
            )
            print(f"{prefix}Clicking SMTP enabled button...")
            smtp_btn.click()
            time.sleep(3)
            
            print(f"{prefix}Checking for OAuth window...")
            # Switch to OAuth window
            all_windows = driver.window_handles
            if len(all_windows) > 1:
                print(f"{prefix}Switching to OAuth window...")
                driver.switch_to.window(all_windows[1])
                
                if complete_oauth_flow(driver, email, password, worker_id):
                    print(f"{prefix}OAuth flow completed, verifying account was added...")
                    
                    # Wait a moment for the account to be processed
                    print(f"{prefix}Waiting 5 seconds for account to be processed in Instantly...")
                    time.sleep(5)
                    
                    # Verify the account was actually added using the API
                    print(f"{prefix}Starting API verification for {email} using {api_version.upper()} API...")
                    
                    # For V2 API, try multiple times with increasing delays due to potential sync issues
                    verification_attempts = 3 if api_version == "v2" else 1
                    verification_success = False
                    
                    for verify_attempt in range(verification_attempts):
                        if verify_attempt > 0:
                            wait_time = 10 * verify_attempt  # 10s, 20s
                            print(f"{prefix}API verification attempt {verify_attempt + 1}/{verification_attempts}, waiting {wait_time}s...")
                            time.sleep(wait_time)
                        
                        if check_email_added(api_key, email, worker_id, api_version):
                            print(f"{Fore.GREEN}{prefix}SUCCESS: {email} verified as added to Instantly{Style.RESET_ALL}")
                            verification_success = True
                            break
                        else:
                            print(f"{prefix}Verification attempt {verify_attempt + 1} failed for {email}")
                    
                    if verification_success:
                        return driver, True
                    else:
                        print(f"{Fore.YELLOW}{prefix}OAuth completed but email not found in API after {verification_attempts} attempts, will retry upload... (attempt {attempt + 1}/{retries}){Style.RESET_ALL}")
                        print(f"{prefix}This could be due to API synchronization delay, indexing latency, or failed account creation")
                else:
                    print(f"{Fore.YELLOW}{prefix}OAuth failed for {email} (attempt {attempt + 1}/{retries}){Style.RESET_ALL}")
            else:
                print(f"{Fore.YELLOW}{prefix}No OAuth window opened{Style.RESET_ALL}")
                
        except TimeoutException as e:
            print(f"{Fore.YELLOW}{prefix}Timeout adding {email} (attempt {attempt + 1}/{retries}): {e}{Style.RESET_ALL}")
        except Exception as e:
            print(f"{Fore.RED}{prefix}Error adding {email} (attempt {attempt + 1}/{retries}): {e}{Style.RESET_ALL}")
        
        # Reset to main window
        try:
            driver.switch_to.window(driver.window_handles[0])
        except:
            pass
    
    print(f"{Fore.RED}{prefix}FAILED: {email} could not be added after {retries} attempts{Style.RESET_ALL}")
    return driver, False

def process_emails(api_key, instantly_email, instantly_password, workspace, csv_path, worker_id, existing_accounts_file=None, api_version="v1"):
    """Main function to process email accounts"""
    init()  # Initialize colorama
    print(f"{Fore.CYAN}Worker {worker_id} starting...{Style.RESET_ALL}")
    
    # Read existing accounts from file if provided, otherwise fetch them
    existing_accounts = []
    if existing_accounts_file and os.path.exists(existing_accounts_file):
        try:
            with open(existing_accounts_file, 'r') as f:
                existing_accounts = [line.strip() for line in f if line.strip()]
            print(f"Worker {worker_id}: Loaded {len(existing_accounts)} existing accounts from file")
        except Exception as e:
            print(f"Worker {worker_id}: Error reading existing accounts file: {e}")
            existing_accounts = []
    else:
        print(f"Worker {worker_id}: No existing accounts file provided")
        existing_accounts = []
    
    # Read CSV file
    accounts_to_process = []
    csv_fieldnames = []
    
    try:
        with open(csv_path, 'r', newline='') as f:
            reader = csv.DictReader(f)
            csv_fieldnames = reader.fieldnames
            
            for row in reader:
                email = row.get('EmailAddress', '').strip()
                password = row.get('Password', '').strip()
                
                if email and password:
                    if email not in existing_accounts:
                        accounts_to_process.append({
                            'email': email,
                            'password': password,
                            'original_row': row
                        })
                    else:
                        print(f"Skipping {email} - already exists")
    except Exception as e:
        print(f"Error reading CSV: {e}")
        return
    
    total = len(accounts_to_process)
    print(f"Worker {worker_id}: Processing {total} accounts")
    
    if total == 0:
        print(f"Worker {worker_id}: No accounts to process")
        return
    
    processed = 0
    failed_accounts = []
    
    try:
        # Process each account with fresh browser
        for account in accounts_to_process:
            email = account['email']
            password = account['password']
            
            print(f"\n{Fore.CYAN}Worker {worker_id}: Processing {email} ({processed + 1}/{total}){Style.RESET_ALL}")
            
            # Add delay between accounts
            if processed > 0:
                delay = 1
                print(f"Worker {worker_id}: Waiting {delay:.1f}s before next account...")
                time.sleep(delay)
            
            # Setup fresh driver for each account
            print(f"Worker {worker_id}: Setting up fresh browser for {email}...")
            driver = setup_driver()
            if not driver:
                print(f"{Fore.RED}Worker {worker_id}: Failed to setup driver for {email}{Style.RESET_ALL}")
                processed += 1
                failed_accounts.append(account['original_row'])
                continue
            
            try:
                # Login to Instantly
                print(f"Worker {worker_id}: Logging into Instantly...")
                if not login_to_instantly(driver, instantly_email, instantly_password, workspace, worker_id):
                    print(f"{Fore.RED}Worker {worker_id}: Failed to login to Instantly for {email}{Style.RESET_ALL}")
                    processed += 1
                    failed_accounts.append(account['original_row'])
                    continue
                
                # Try to add account
                print(f"Worker {worker_id}: Adding email account {email}...")
                driver, success = add_email_account(driver, api_key, instantly_email, instantly_password, workspace, email, password, worker_id, MAX_RETRIES_PER_ACCOUNT, api_version)
                if success:
                    processed += 1
                    print(f"{Fore.GREEN}SUCCESS: {email} added ({processed}/{total}){Style.RESET_ALL}")
                else:
                    processed += 1
                    failed_accounts.append(account['original_row'])
                    print(f"{Fore.RED}FAILED: {email} ({processed}/{total}){Style.RESET_ALL}")
                    
            finally:
                # Always close browser after each account
                print(f"Worker {worker_id}: Closing browser for {email}...")
                try:
                    driver.quit()
                except:
                    pass
        
    except KeyboardInterrupt:
        print(f"\n{Fore.YELLOW}Worker {worker_id}: Interrupted by user{Style.RESET_ALL}")
    except Exception as e:
        print(f"\n{Fore.RED}Worker {worker_id} error: {e}{Style.RESET_ALL}")
    finally:
        print(f"\n{Fore.CYAN}Worker {worker_id}: Completed {processed}/{total} accounts{Style.RESET_ALL}")
        
        # Save failed accounts if any
        if failed_accounts:
            timestamp = datetime.now().strftime('%m-%d-%Y_%H-%M')
            failed_csv = f"failed_accounts_worker{worker_id}_{timestamp}.csv"
            
            with open(failed_csv, 'w', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=csv_fieldnames)
                writer.writeheader()
                writer.writerows(failed_accounts)
            
            print(f"{Fore.YELLOW}Worker {worker_id}: Saved {len(failed_accounts)} failed accounts to {failed_csv}{Style.RESET_ALL}")

def main():
    """Entry point for worker process"""
    if len(sys.argv) < 8:
        print("Usage: upload.py <api_key> <email> <password> <workspace> <csv_file> <worker_id> <api_version> [existing_accounts_file] [v2_api_key]")
        sys.exit(1)
    
    api_key = sys.argv[1]
    instantly_email = sys.argv[2]
    instantly_password = sys.argv[3]
    workspace = sys.argv[4]
    csv_path = sys.argv[5]
    worker_id = sys.argv[6]
    api_version = sys.argv[7] if len(sys.argv) > 7 else "v1"
    existing_accounts_file = sys.argv[8] if len(sys.argv) > 8 else None
    v2_api_key = sys.argv[9] if len(sys.argv) > 9 else None
    
    # Use V2 API key if provided and using V2 API
    final_api_key = v2_api_key if api_version == "v2" and v2_api_key else api_key
    
    process_emails(final_api_key, instantly_email, instantly_password, workspace, csv_path, worker_id, existing_accounts_file, api_version)

if __name__ == '__main__':
    main()
