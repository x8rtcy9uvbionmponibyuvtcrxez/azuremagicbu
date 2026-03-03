import tkinter as tk
from tkinter import filedialog, messagebox
import subprocess
import os
import sys
import threading
import csv
import re
import tempfile

# Global variable to hold the list of CSV file paths.
csv_files = []

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
    log_text.insert(tk.END, message + "\n")
    log_text.configure(state='disabled')
    log_text.see(tk.END)

def thread_safe_log(message):
    """Schedule a log message to be appended from a background thread."""
    root.after(0, append_log, message)

def extract_domain(email):
    """Extract domain from email address."""
    match = re.search(r'@([^@]+)$', email)
    if match:
        return match.group(1)
    return None

def get_first_email_domain(csv_file):
    """Extract domain from the first email in column 2 of a CSV file."""
    try:
        with open(csv_file, 'r') as f:
            reader = csv.reader(f)
            next(reader)  # Skip header
            for row in reader:
                if len(row) > 1:
                    email = row[1]  # Column 2 (index 1)
                    domain = extract_domain(email)
                    if domain:
                        return domain
        return None
    except Exception as e:
        thread_safe_log(f"Error reading {csv_file}: {str(e)}")
        return None

def process_csv_files():
    """Start a background thread to process the CSV files."""
    threading.Thread(target=process_csv_files_thread, daemon=True).start()

def process_csv_files_thread():
    """Process each CSV file and run the config_enable.py script for each domain."""
    # Get API keys from the input fields
    v1_api_key = v1_api_key_entry.get().strip()
    v2_api_key = v2_api_key_entry.get().strip()
    
    # Validate inputs
    if not v1_api_key or not v2_api_key:
        thread_safe_log("Error: Both V1 and V2 API keys are required.")
        root.after(0, lambda: messagebox.showerror("Input Error", "Please provide both V1 and V2 API keys."))
        return
    
    if not csv_files:
        thread_safe_log("Error: No CSV files selected.")
        root.after(0, lambda: messagebox.showerror("Input Error", "Please select at least one CSV file."))
        return
    
    # Process each CSV file
    processed_domains = set()
    total_files = len(csv_files)
    success_count = 0
    
    for i, csv_file in enumerate(csv_files):
        file_name = os.path.basename(csv_file)
        thread_safe_log(f"Processing file {i+1}/{total_files}: {file_name}")
        
        # Extract domain from the first email in the CSV
        domain = get_first_email_domain(csv_file)
        if not domain:
            thread_safe_log(f"Error: Could not extract domain from {file_name}")
            continue
        
        # Skip if we've already processed this domain
        if domain in processed_domains:
            thread_safe_log(f"Skipping domain {domain} (already processed)")
            continue
        
        thread_safe_log(f"Found domain: {domain}")
        processed_domains.add(domain)
        
        # Run config_enable.py with V1 API key, V2 API key, and domain
        thread_safe_log(f"Running config_enable.py for domain: {domain}")
        try:
            config_proc = subprocess.Popen(
                [sys.executable, "config_enable.py", v1_api_key, v2_api_key, domain],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            
            # Process output in real-time
            while True:
                output = config_proc.stdout.readline()
                if output:
                    thread_safe_log(output.strip())
                if output == '' and config_proc.poll() is not None:
                    break
            
            # Check for errors
            stderr = config_proc.stderr.read()
            if stderr:
                thread_safe_log(f"config_enable.py stderr: {stderr}")
            
            if config_proc.returncode != 0:
                thread_safe_log(f"Error: config_enable.py failed for domain {domain}")
                continue
                
            success_count += 1
            thread_safe_log(f"Successfully processed domain: {domain}")
            
        except Exception as e:
            thread_safe_log(f"Error processing {domain}: {str(e)}")
    
    # Final summary
    thread_safe_log(f"\nProcessing complete. Successfully processed {success_count}/{len(processed_domains)} domains.")
    root.after(0, lambda: messagebox.showinfo("Processing Complete", 
                                             f"Successfully processed {success_count}/{len(processed_domains)} domains."))

# --------------------- Build the Tkinter UI --------------------- #
root = tk.Tk()
root.title("Domain Processing Tool")
root.geometry("600x700")  # Set initial window size

# ----- API Keys Group -----
api_keys_frame = tk.LabelFrame(root, text="API Keys", padx=10, pady=10)
api_keys_frame.pack(padx=10, pady=5, fill="x")

tk.Label(api_keys_frame, text="V1 API Key:").grid(row=0, column=0, sticky="e", padx=5, pady=5)
v1_api_key_entry = tk.Entry(api_keys_frame, width=40)
v1_api_key_entry.grid(row=0, column=1, padx=5, pady=5)

tk.Label(api_keys_frame, text="V2 API Key:").grid(row=1, column=0, sticky="e", padx=5, pady=5)
v2_api_key_entry = tk.Entry(api_keys_frame, width=40)
v2_api_key_entry.grid(row=1, column=1, padx=5, pady=5)

# ----- CSV File Manager Group -----
csv_frame = tk.LabelFrame(root, text="CSV File Manager", padx=10, pady=10)
csv_frame.pack(padx=10, pady=5, fill="both", expand=True)

# Listbox with a scrollbar
csv_listbox = tk.Listbox(csv_frame, height=6)
csv_listbox.pack(side="left", fill="both", expand=True, padx=(0, 5))
csv_scrollbar = tk.Scrollbar(csv_frame, command=csv_listbox.yview)
csv_scrollbar.pack(side="right", fill="y")
csv_listbox.config(yscrollcommand=csv_scrollbar.set)

browse_button = tk.Button(csv_frame, text="Browse CSV Files", command=browse_csv_files)
browse_button.pack(pady=5)

# ----- Process Button -----
process_button = tk.Button(root, text="Process Files", command=process_csv_files, padx=20, pady=5)
process_button.pack(pady=10)

# ----- Debug Log Group -----
log_frame = tk.LabelFrame(root, text="Debug Log", padx=10, pady=10)
log_frame.pack(padx=10, pady=5, fill="both", expand=True)
log_text = tk.Text(log_frame, height=15, state="disabled")
log_text.pack(side="left", fill="both", expand=True)
scrollbar = tk.Scrollbar(log_frame, command=log_text.yview)
scrollbar.pack(side="right", fill="y")
log_text.config(yscrollcommand=scrollbar.set)

# Start the application
if __name__ == "__main__":
    root.mainloop()
