#!/usr/bin/env python3
import tkinter as tk
from tkinter import filedialog, messagebox
import subprocess
import os
import sys
import threading
import csv
import tempfile
import shutil
import requests
from datetime import datetime
from pathlib import Path

# Global variables for CSV files and processes
csv_files = []
master_procs = []  # List to hold multiple upload.py subprocesses

def browse_csv_files():
    """Open a file dialog to select multiple CSV files and display their filenames."""
    global csv_files
    files = filedialog.askopenfilenames(
        title="Select CSV Files",
        filetypes=[("CSV Files", "*.csv"), ("All Files", "*.*")]
    )
    if files:
        csv_files = list(files)
        update_csv_listbox()
        append_log(f"Selected {len(csv_files)} CSV file(s).")

def update_csv_listbox():
    """Update the Listbox widget with the selected CSV file names."""
    csv_listbox.delete(0, tk.END)
    for file_path in csv_files:
        csv_listbox.insert(tk.END, os.path.basename(file_path))

def append_log(message):
    """Append a message to the debug log text widget."""
    log_text.configure(state='normal')
    log_text.insert(tk.END, f"[{datetime.now().strftime('%H:%M:%S')}] {message}\n")
    log_text.configure(state='disabled')
    log_text.see(tk.END)

def thread_safe_log(message):
    """Schedule a log message to be appended from a background thread."""
    root.after(0, append_log, message)

def fetch_existing_accounts_v1(api_key, max_accounts=300000):
    """Fetch existing email accounts from Instantly V1 API with pagination"""
    base_url = "https://api.instantly.ai/api/v1/account/list"
    all_accounts = []
    skip = 0
    limit = 100  # API limit per request
    
    try:
        thread_safe_log("Fetching existing accounts from Instantly V1 API...")
        
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
                    thread_safe_log(f"Unexpected API response format: {type(data)}")
                    break
            else:
                thread_safe_log(f"API Error: Status {response.status_code}")
                thread_safe_log(f"Response: {response.text[:500]}...")
                break
                
        thread_safe_log(f"Found {len(all_accounts)} total existing accounts in Instantly")
    except requests.exceptions.RequestException as e:
        thread_safe_log(f"Request error: {e}")
    except Exception as e:
        thread_safe_log(f"Error fetching accounts: {e}")
    
    return all_accounts

def fetch_existing_accounts_v2(api_key, max_accounts=300000):
    """Fetch existing email accounts from Instantly V2 API with cursor-based pagination"""
    base_url = "https://api.instantly.ai/api/v2/accounts"
    all_accounts = []
    limit = 100  # API limit per request
    starting_after = None
    batch_count = 0
    
    try:
        thread_safe_log("V2 API: Starting to fetch existing accounts...")
        
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
            
            thread_safe_log(f"V2 API: Fetching batch {batch_count} (limit={limit}, starting_after={starting_after})")
            response = requests.get(base_url, headers=headers, params=params)
            
            if response.status_code == 200:
                data = response.json()
                
                # Handle the V2 response format with 'items' key
                if isinstance(data, dict) and 'items' in data:
                    account_list = data['items']
                    thread_safe_log(f"V2 API: Retrieved {len(account_list)} accounts in this batch")
                    
                    if not account_list:  # No more accounts
                        thread_safe_log("V2 API: No more accounts to fetch (empty items)")
                        break
                    
                    emails = [acc.get('email', '') for acc in account_list if acc.get('email')]
                    all_accounts.extend(emails)
                    thread_safe_log(f"V2 API: Added {len(emails)} emails to collection. Total so far: {len(all_accounts)}")
                    
                    # Check for next_starting_after to continue pagination
                    next_starting_after = data.get('next_starting_after')
                    if next_starting_after and next_starting_after != starting_after:
                        starting_after = next_starting_after
                        thread_safe_log(f"V2 API: Next cursor: {starting_after}")
                    else:
                        thread_safe_log("V2 API: No more pages (no next_starting_after or same cursor)")
                        break
                    
                    # If we got less than limit, we've likely reached the end
                    if len(account_list) < limit:
                        thread_safe_log(f"V2 API: Reached end of accounts (got {len(account_list)} < {limit})")
                        break
                        
                else:
                    thread_safe_log(f"Unexpected V2 API response format: {type(data)}")
                    thread_safe_log(f"Response preview: {str(data)[:200]}...")
                    break
            else:
                thread_safe_log(f"V2 API Error: Status {response.status_code}")
                thread_safe_log(f"Response: {response.text[:500]}...")
                break
                
        thread_safe_log(f"V2 API: Found {len(all_accounts)} total existing accounts in Instantly")
    except requests.exceptions.RequestException as e:
        thread_safe_log(f"V2 API Request error: {e}")
    except Exception as e:
        thread_safe_log(f"V2 API Error fetching accounts: {e}")
    
    return all_accounts

def fetch_existing_accounts(api_key, api_version="v1", max_accounts=300000):
    """Fetch existing accounts using the specified API version"""
    if api_version == "v2":
        return fetch_existing_accounts_v2(api_key, max_accounts)
    else:
        return fetch_existing_accounts_v1(api_key, max_accounts)

def combine_csv_files(file_list):
    """
    Combine multiple CSV files into a single temporary CSV file.
    Assumes all CSVs share the same header.
    """
    if not file_list:
        return None

    temp_file = tempfile.NamedTemporaryFile(mode='w', delete=False, newline='', suffix=".csv")
    writer = None
    total_rows = 0

    for idx, file_path in enumerate(file_list):
        with open(file_path, newline='') as csv_in:
            reader = csv.DictReader(csv_in)
            if writer is None:
                writer = csv.DictWriter(temp_file, fieldnames=reader.fieldnames)
                writer.writeheader()
            
            for row in reader:
                writer.writerow(row)
                total_rows += 1
                
    temp_file.close()
    thread_safe_log(f"Combined {len(file_list)} files into {total_rows} total accounts")
    return temp_file.name

def split_csv_file(csv_path, parts=3):
    """
    Split the CSV file at csv_path into 'parts' separate CSV files.
    Returns a list of file paths for the split CSVs and the temporary directory containing them.
    """
    with open(csv_path, 'r', newline='') as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        rows = list(reader)

    total_rows = len(rows)
    thread_safe_log(f"Total accounts to process: {total_rows}")

    rows_per_file = total_rows // parts
    remainder = total_rows % parts

    temp_dir = tempfile.mkdtemp(prefix="instantly_split_")
    output_files = []
    start = 0

    for i in range(parts):
        extra = 1 if i < remainder else 0
        end = start + rows_per_file + extra
        part_rows = rows[start:end]

        output_file = os.path.join(temp_dir, f"split_{i+1}.csv")
        with open(output_file, 'w', newline='') as out:
            writer = csv.DictWriter(out, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(part_rows)

        thread_safe_log(f"Worker {i+1}: {len(part_rows)} accounts (rows {start+1}-{end})")
        output_files.append(output_file)
        start = end

    return output_files, temp_dir

def monitor_process(proc, instance_name):
    """Monitor the output of a subprocess and log it."""
    while True:
        output = proc.stdout.readline()
        if output:
            thread_safe_log(f"{instance_name}: {output.strip()}")
        if output == "" and proc.poll() is not None:
            break
    
    # Read any remaining stderr
    err_output = proc.stderr.read()
    if err_output:
        thread_safe_log(f"{instance_name} Error: {err_output.strip()}")

def run_upload_script():
    """Start a background thread to run upload.py in 3 parallel instances."""
    threading.Thread(target=run_upload_script_thread, daemon=True).start()

def run_upload_script_thread():
    global master_procs
    master_procs = []
    script_dir = os.path.dirname(__file__)
    
    # Retrieve values from UI fields
    api_version = api_version_var.get()
    v1_api_key = api_key_entry.get().strip()
    v2_api_key = v2_api_key_entry.get().strip()
    instantly_email = instantly_email_entry.get().strip()
    instantly_password = instantly_password_entry.get().strip()
    workspace = workspace_entry.get().strip()
    
    # Determine which API key to use based on version
    if api_version == "v2":
        if not v2_api_key:
            thread_safe_log("Error: V2 API Key is required when V2 API is selected.")
            root.after(0, lambda: messagebox.showerror("Input Error", "Please provide V2 API Key."))
            return
        primary_api_key = v2_api_key
    else:
        if not v1_api_key:
            thread_safe_log("Error: V1 API Key is required when V1 API is selected.")
            root.after(0, lambda: messagebox.showerror("Input Error", "Please provide V1 API Key."))
            return
        primary_api_key = v1_api_key

    if not all([primary_api_key, instantly_email, instantly_password, csv_files]):
        thread_safe_log("Error: API Key, Instantly Email, Instantly Password and at least one CSV file are required.")
        root.after(0, lambda: messagebox.showerror("Input Error", "Please fill in all fields and select at least one CSV file."))
        return

    # Update UI state
    root.after(0, lambda: run_button.config(state='disabled'))
    root.after(0, lambda: progress_label.config(text="Processing..."))
    
    # Combine CSV files into one temporary file
    combined_csv_path = combine_csv_files(csv_files)
    if not combined_csv_path:
        thread_safe_log("Error combining CSV files.")
        root.after(0, lambda: messagebox.showerror("Error", "Could not combine CSV files."))
        root.after(0, lambda: run_button.config(state='normal'))
        return
    
    # Split the combined CSV into parts first
    num_workers = int(num_workers_var.get())
    split_files, split_dir = split_csv_file(combined_csv_path, parts=num_workers)
    thread_safe_log(f"CSV file split into {num_workers} parts")
    
    # Fetch existing accounts once
    root.after(0, lambda: progress_label.config(text="Fetching existing accounts..."))
    existing_accounts = fetch_existing_accounts(primary_api_key, api_version)
    
    # Save existing accounts to a temporary file
    existing_accounts_file = os.path.join(split_dir, "existing_accounts.txt")
    try:
        with open(existing_accounts_file, 'w') as f:
            for email in existing_accounts:
                f.write(f"{email}\n")
        thread_safe_log(f"Saved {len(existing_accounts)} existing accounts to temp file")
    except Exception as e:
        thread_safe_log(f"Error saving existing accounts: {e}")
        existing_accounts_file = None
    
    # Prepare the absolute path for the upload.py script
    upload_script_path = os.path.join(script_dir, "upload.py")
    
    process_threads = []
    start_time = datetime.now()
    
    # Launch parallel instances of upload.py, one for each split CSV
    for i, split_file in enumerate(split_files, start=1):
        args = [
            sys.executable,
            upload_script_path,
            primary_api_key,
            instantly_email,
            instantly_password,
            workspace,
            split_file,
            str(i),
            api_version
        ]
        
        # Add existing accounts file if available
        if existing_accounts_file:
            args.append(existing_accounts_file)
        
        # Add V2 API key if using V2 and it's different from primary
        if api_version == "v2":
            args.append(v2_api_key)
        
        thread_safe_log(f"Launching Worker {i}...")
        try:
            proc = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=script_dir,
                stdin=subprocess.DEVNULL
            )
            master_procs.append(proc)
            t = threading.Thread(target=monitor_process, args=(proc, f"Worker {i}"), daemon=True)
            t.start()
            process_threads.append(t)
        except Exception as ex:
            thread_safe_log(f"Error launching Worker {i}: {ex}")
    
    thread_safe_log(f"\nProcessing accounts with {num_workers} parallel workers...")
    
    # Wait for all processes to complete
    for proc in master_procs:
        proc.wait()
    
    for t in process_threads:
        t.join()
    
    end_time = datetime.now()
    duration = end_time - start_time
    
    # Check exit codes of all instances
    exit_codes = [proc.returncode for proc in master_procs]
    thread_safe_log(f"\nAll workers completed. Total processing time: {duration}")
    
    # Cleanup temporary files
    try:
        os.remove(combined_csv_path)
        thread_safe_log("Temporary combined CSV file removed.")
    except Exception as e:
        thread_safe_log(f"Could not remove temporary combined CSV file: {e}")
    
    try:
        shutil.rmtree(split_dir)
        thread_safe_log("Temporary split CSV directory removed.")
    except Exception as e:
        thread_safe_log(f"Could not remove temporary split CSV directory: {e}")
    
    # Check for failed accounts files from workers
    failed_files = []
    for file in os.listdir(script_dir):
        if file.startswith("failed_accounts_worker") and file.endswith(".csv"):
            failed_files.append(file)
    
    if failed_files:
        thread_safe_log(f"\nWorker failed accounts saved to:")
        for f in failed_files:
            thread_safe_log(f"  - {f}")
    
    # Automatically run upload verification
    thread_safe_log("\nStarting automatic upload verification...")
    run_upload_check_after_processing(primary_api_key, api_version)
    
    # Reset UI state
    root.after(0, lambda: run_button.config(state='normal'))
    root.after(0, lambda: progress_label.config(text="Ready"))
    master_procs = []

def cancel_process():
    """Cancel any running upload.py processes."""
    global master_procs
    if master_procs:
        thread_safe_log("Terminating all running processes...")
        for i, proc in enumerate(master_procs):
            try:
                thread_safe_log(f"Terminating Worker {i+1} (PID: {proc.pid})")
                proc.terminate()
                # Wait briefly for graceful termination
                try:
                    proc.wait(timeout=2)
                    thread_safe_log(f"Worker {i+1} terminated gracefully")
                except subprocess.TimeoutExpired:
                    thread_safe_log(f"Worker {i+1} did not terminate gracefully, forcing kill...")
                    proc.kill()
                    proc.wait()
                    thread_safe_log(f"Worker {i+1} forcefully killed")
            except Exception as e:
                thread_safe_log(f"Error terminating Worker {i+1}: {e}")
        
        thread_safe_log("All processes terminated.")
        # Re-enable the run button and reset UI state
        root.after(0, lambda: run_button.config(state='normal'))
        root.after(0, lambda: progress_label.config(text="Cancelled"))
        root.after(0, lambda: messagebox.showinfo("Cancelled", "All processes have been terminated."))
        master_procs = []
    else:
        thread_safe_log("No process is currently running.")
        root.after(0, lambda: messagebox.showinfo("Info", "No process is currently running."))

def check_upload():
    """Start a background thread to check uploaded accounts."""
    threading.Thread(target=check_upload_thread, daemon=True).start()

def check_upload_thread():
    """Check which accounts from CSV files are missing from Instantly."""
    api_version = api_version_var.get()
    v1_api_key = api_key_entry.get().strip()
    v2_api_key = v2_api_key_entry.get().strip()
    
    # Determine which API key to use
    if api_version == "v2":
        if not v2_api_key:
            thread_safe_log("Error: V2 API Key is required when V2 API is selected.")
            root.after(0, lambda: messagebox.showerror("Input Error", "Please provide V2 API Key."))
            return
        api_key = v2_api_key
    else:
        if not v1_api_key:
            thread_safe_log("Error: V1 API Key is required when V1 API is selected.")
            root.after(0, lambda: messagebox.showerror("Input Error", "Please provide V1 API Key."))
            return
        api_key = v1_api_key
    
    if not csv_files:
        thread_safe_log("Error: At least one CSV file is required for checking uploads.")
        root.after(0, lambda: messagebox.showerror("Input Error", "Please select at least one CSV file."))
        return
    
    # Update UI state
    root.after(0, lambda: check_button.config(state='disabled'))
    root.after(0, lambda: progress_label.config(text="Checking uploads..."))
    
    try:
        # Fetch existing accounts from Instantly
        thread_safe_log("Starting upload check...")
        existing_accounts = fetch_existing_accounts(api_key, api_version)
        existing_accounts_lower = [email.lower() for email in existing_accounts]
        
        # Read all CSV files and collect email addresses
        thread_safe_log("Reading CSV files...")
        csv_emails = []
        csv_fieldnames = []
        failed_accounts = []
        
        for csv_file in csv_files:
            try:
                with open(csv_file, 'r', newline='') as f:
                    reader = csv.DictReader(f)
                    if not csv_fieldnames:
                        csv_fieldnames = reader.fieldnames
                    
                    for row in reader:
                        email = row.get('EmailAddress', '').strip()
                        if email:
                            csv_emails.append({
                                'email': email,
                                'original_row': row
                            })
            except Exception as e:
                thread_safe_log(f"Error reading {os.path.basename(csv_file)}: {e}")
        
        thread_safe_log(f"Found {len(csv_emails)} total emails in CSV files")
        
        # Compare CSV emails with existing accounts
        thread_safe_log("Comparing with existing accounts...")
        for item in csv_emails:
            email = item['email']
            if email.lower() not in existing_accounts_lower:
                failed_accounts.append(item['original_row'])
        
        failed_count = len(failed_accounts)
        thread_safe_log(f"Found {failed_count} accounts missing from Instantly")
        
        # Update status display
        if failed_count > 0:
            status_text = f"Missing: {failed_count} accounts"
            root.after(0, lambda: status_label.config(text=status_text, fg="red"))
            
            # Save failed accounts to CSV
            timestamp = datetime.now().strftime('%d-%m-%Y_%H-%M')
            failed_csv_path = f"failed_accounts_{timestamp}.csv"
            
            try:
                with open(failed_csv_path, 'w', newline='') as f:
                    writer = csv.DictWriter(f, fieldnames=csv_fieldnames)
                    writer.writeheader()
                    writer.writerows(failed_accounts)
                
                thread_safe_log(f"Saved {failed_count} missing accounts to {failed_csv_path}")
                root.after(0, lambda: messagebox.showinfo("Check Complete", 
                    f"Found {failed_count} missing accounts.\nSaved to: {failed_csv_path}"))
                
            except Exception as e:
                thread_safe_log(f"Error saving failed accounts CSV: {e}")
                root.after(0, lambda: messagebox.showerror("Error", 
                    f"Found {failed_count} missing accounts but failed to save CSV: {e}"))
        else:
            status_text = "All accounts uploaded!"
            root.after(0, lambda: status_label.config(text=status_text, fg="green"))
            root.after(0, lambda: messagebox.showinfo("Check Complete", 
                "All accounts from CSV files are present in Instantly!"))
    
    except Exception as e:
        thread_safe_log(f"Error during upload check: {e}")
        root.after(0, lambda: messagebox.showerror("Error", f"Upload check failed: {e}"))
    
    finally:
        # Reset UI state
        root.after(0, lambda: check_button.config(state='normal'))
        root.after(0, lambda: progress_label.config(text="Ready"))

def run_upload_check_after_processing(api_key, api_version="v1"):
    """Run upload check after processing completes (without UI updates)."""
    try:
        # Fetch existing accounts from Instantly
        thread_safe_log("Verifying upload results...")
        existing_accounts = fetch_existing_accounts(api_key, api_version)
        existing_accounts_lower = [email.lower() for email in existing_accounts]
        
        # Read all CSV files and collect email addresses
        csv_emails = []
        csv_fieldnames = []
        failed_accounts = []
        
        for csv_file in csv_files:
            try:
                with open(csv_file, 'r', newline='') as f:
                    reader = csv.DictReader(f)
                    if not csv_fieldnames:
                        csv_fieldnames = reader.fieldnames
                    
                    for row in reader:
                        email = row.get('EmailAddress', '').strip()
                        if email:
                            csv_emails.append({
                                'email': email,
                                'original_row': row
                            })
            except Exception as e:
                thread_safe_log(f"Error reading {os.path.basename(csv_file)}: {e}")
        
        # Compare CSV emails with existing accounts
        for item in csv_emails:
            email = item['email']
            if email.lower() not in existing_accounts_lower:
                failed_accounts.append(item['original_row'])
        
        failed_count = len(failed_accounts)
        total_count = len(csv_emails)
        success_count = total_count - failed_count
        
        thread_safe_log(f"Upload verification complete: {success_count}/{total_count} accounts successfully uploaded")
        
        # Update status display
        if failed_count > 0:
            status_text = f"Uploaded: {success_count}/{total_count} (Missing: {failed_count})"
            root.after(0, lambda: status_label.config(text=status_text, fg="orange"))
            
            # Save failed accounts to CSV
            timestamp = datetime.now().strftime('%d-%m-%Y_%H-%M')
            failed_csv_path = f"failed_accounts_{timestamp}.csv"
            
            try:
                with open(failed_csv_path, 'w', newline='') as f:
                    writer = csv.DictWriter(f, fieldnames=csv_fieldnames)
                    writer.writeheader()
                    writer.writerows(failed_accounts)
                
                thread_safe_log(f"Saved {failed_count} missing accounts to {failed_csv_path}")
                root.after(0, lambda: messagebox.showinfo("Upload Complete", 
                    f"Processing finished!\n\nUploaded: {success_count}/{total_count} accounts\nMissing: {failed_count} accounts\n\nMissing accounts saved to: {failed_csv_path}"))
                
            except Exception as e:
                thread_safe_log(f"Error saving failed accounts CSV: {e}")
                root.after(0, lambda: messagebox.showwarning("Upload Complete", 
                    f"Processing finished!\n\nUploaded: {success_count}/{total_count} accounts\nMissing: {failed_count} accounts\n\nFailed to save missing accounts CSV: {e}"))
        else:
            status_text = f"All {total_count} accounts uploaded successfully!"
            root.after(0, lambda: status_label.config(text=status_text, fg="green"))
            root.after(0, lambda: messagebox.showinfo("Upload Complete", 
                f"Processing finished!\n\nAll {total_count} accounts uploaded successfully!"))
    
    except Exception as e:
        thread_safe_log(f"Error during upload verification: {e}")
        root.after(0, lambda: messagebox.showerror("Verification Error", f"Upload verification failed: {e}"))

# --------------------- Build the Tkinter UI --------------------- #
root = tk.Tk()
root.title("Instantly Uploader - GUI")
root.geometry("600x700")

# ----- Title Label -----
title_label = tk.Label(root, text="Instantly Uploader", font=("Arial", 16, "bold"))
title_label.pack(pady=10)

# ----- Credentials Group -----
credentials_frame = tk.LabelFrame(root, text="Instantly Credentials", padx=10, pady=10)
credentials_frame.pack(padx=10, pady=5, fill="x")

# API Version Toggle
tk.Label(credentials_frame, text="API Version:").grid(row=0, column=0, sticky="e", padx=5, pady=5)
api_version_var = tk.StringVar(value="v1")
api_v1_radio = tk.Radiobutton(credentials_frame, text="V1", variable=api_version_var, value="v1")
api_v1_radio.grid(row=0, column=1, sticky="w", padx=5, pady=5)
api_v2_radio = tk.Radiobutton(credentials_frame, text="V2", variable=api_version_var, value="v2")
api_v2_radio.grid(row=0, column=1, sticky="w", padx=80, pady=5)

tk.Label(credentials_frame, text="V1 API Key:").grid(row=1, column=0, sticky="e", padx=5, pady=5)
api_key_entry = tk.Entry(credentials_frame, width=40)
api_key_entry.grid(row=1, column=1, padx=5, pady=5)

tk.Label(credentials_frame, text="V2 API Key:").grid(row=2, column=0, sticky="e", padx=5, pady=5)
v2_api_key_entry = tk.Entry(credentials_frame, width=40)
v2_api_key_entry.grid(row=2, column=1, padx=5, pady=5)

tk.Label(credentials_frame, text="Instantly Email:").grid(row=3, column=0, sticky="e", padx=5, pady=5)
instantly_email_entry = tk.Entry(credentials_frame, width=40)
instantly_email_entry.grid(row=3, column=1, padx=5, pady=5)

tk.Label(credentials_frame, text="Instantly Password:").grid(row=4, column=0, sticky="e", padx=5, pady=5)
instantly_password_entry = tk.Entry(credentials_frame, width=40, show="*")
instantly_password_entry.grid(row=4, column=1, padx=5, pady=5)

tk.Label(credentials_frame, text="Workspace:").grid(row=5, column=0, sticky="e", padx=5, pady=5)
workspace_entry = tk.Entry(credentials_frame, width=40)
workspace_entry.grid(row=5, column=1, padx=5, pady=5)

# ----- Settings Group -----
settings_frame = tk.LabelFrame(root, text="Settings", padx=10, pady=10)
settings_frame.pack(padx=10, pady=5, fill="x")

tk.Label(settings_frame, text="Number of Workers:").grid(row=0, column=0, sticky="e", padx=5, pady=5)
num_workers_var = tk.StringVar(value="3")
num_workers_menu = tk.OptionMenu(settings_frame, num_workers_var, "1", "2", "3", "4", "5")
num_workers_menu.grid(row=0, column=1, sticky="w", padx=5, pady=5)

# ----- CSV File Manager Group -----
csv_frame = tk.LabelFrame(root, text="CSV File Manager", padx=10, pady=10)
csv_frame.pack(padx=10, pady=5, fill="both", expand=True)

csv_listbox = tk.Listbox(csv_frame, height=6)
csv_listbox.pack(side="left", fill="both", expand=True, padx=(0, 5))
csv_scrollbar = tk.Scrollbar(csv_frame, command=csv_listbox.yview)
csv_scrollbar.pack(side="right", fill="y")
csv_listbox.config(yscrollcommand=csv_scrollbar.set)

browse_button = tk.Button(csv_frame, text="Browse CSV Files", command=browse_csv_files)
browse_button.pack(pady=5)

# ----- Status and Progress -----
status_frame = tk.Frame(root)
status_frame.pack(pady=5)

progress_label = tk.Label(status_frame, text="Ready", font=("Arial", 10))
progress_label.pack()

# Status label for failed account count
status_label = tk.Label(status_frame, text="", font=("Arial", 10, "bold"))
status_label.pack()

# ----- Run and Cancel Buttons -----
button_frame = tk.Frame(root)
button_frame.pack(pady=10)

run_button = tk.Button(button_frame, text="Run Upload", command=run_upload_script, bg="#4CAF50", fg="white", padx=20)
run_button.pack(side="left", padx=5)

cancel_button = tk.Button(button_frame, text="Cancel Process", command=cancel_process, bg="#f44336", fg="white", padx=20)
cancel_button.pack(side="left", padx=5)

check_button = tk.Button(button_frame, text="Check Upload", command=check_upload, bg="#2196F3", fg="white", padx=20)
check_button.pack(side="left", padx=5)

# ----- Debug Log Group -----
log_frame = tk.LabelFrame(root, text="Debug Log", padx=10, pady=10)
log_frame.pack(padx=10, pady=5, fill="both", expand=True)
log_text = tk.Text(log_frame, height=15, state="disabled", bg="#f0f0f0")
log_text.pack(side="left", fill="both", expand=True)
scrollbar = tk.Scrollbar(log_frame, command=log_text.yview)
scrollbar.pack(side="right", fill="y")
log_text.config(yscrollcommand=scrollbar.set)

# ----- Footer -----
footer_label = tk.Label(root, text="Instantly Uploader v2.0 - Simplified Edition", font=("Arial", 8), fg="gray")
footer_label.pack(pady=5)

root.mainloop()
