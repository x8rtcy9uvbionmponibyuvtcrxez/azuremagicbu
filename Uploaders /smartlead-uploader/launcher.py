import os
import csv
import tempfile
import threading
import importlib.util
import subprocess
import sys
import PySimpleGUI as sg

# Utility to combine multiple CSV files into one
def combine_csv_files(file_list):
    """Combine multiple CSV files into a temporary file for processing."""
    if not file_list:
        return None
        
    from datetime import datetime
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    temp_file = f'temp_combined_{timestamp}.csv'
    
    # Read all files and combine them
    all_rows = []
    header = None
    
    for file in file_list:
        try:
            with open(file, newline='', mode='r') as f:
                reader = csv.DictReader(f)
                if not header:
                    header = reader.fieldnames
                    # Verify required columns exist
                    if 'EmailAddress' not in header or 'Password' not in header:
                        print(f"Error: CSV file {file} missing required columns 'EmailAddress' or 'Password'")
                        return None
                for row in reader:
                    # Verify the row has the required fields before adding
                    if 'EmailAddress' in row and 'Password' in row:
                        all_rows.append(row)
                    else:
                        print(f"Warning: Skipping row in {file} missing required fields")
        except Exception as e:
            print(f"Error reading {file}: {e}")
            return None
            
    # Write the combined rows to a temporary file
    try:
        with open(temp_file, 'w', newline='') as tmp:
            writer = csv.DictWriter(tmp, fieldnames=header)
            writer.writeheader()
            writer.writerows(all_rows)
        return temp_file
    except Exception as e:
        print(f"Error writing to temporary file: {e}")
        return None

# Dynamically load sl-python.py as a module
def load_sl_module(module_name):
    script_dir = os.path.dirname(__file__)
    path = os.path.join(script_dir, f"{module_name}.py")
    
    # Check if file exists
    if not os.path.exists(path):
        return None
        
    spec = importlib.util.spec_from_file_location(f"{module_name}_mod", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

sl_mod = load_sl_module("sl-python")
sl_complete_mod = load_sl_module("sl-complete")

sg.theme("SystemDefault")

layout = [
    [sg.Text("API Key:"), sg.Input(key="-API-KEY-", size=(60,1))],
    [sg.Text("Login URL:"), sg.Input(key="-URL-", size=(60,1))],
    [sg.Text("CSV Files:")],
    [sg.Input(key="-FILE-PATH-", enable_events=True, visible=False),
     sg.FilesBrowse("Select CSV Files", file_types=(("CSV Files","*.csv"),), target="-FILE-PATH-", key="-BROWSE-"),
     sg.Button("Clear List", key="-CLEAR-LIST-")],
    [sg.Listbox(values=[], size=(70,5), key="-FILE-LIST-")],
    [sg.Button("Run", key="-RUN-"), sg.Button("Exit")],
    [sg.Text("Email Processing:", size=(20,1)), sg.Text("", size=(50,1), key="-PROGRESS-TEXT-")],
    [sg.ProgressBar(max_value=1, orientation="h", size=(60,20), key="-PROGRESS-")],
    [sg.Text("Failed Accounts:", size=(20,1)), sg.Text("", size=(50,1), key="-FAILED-PROGRESS-TEXT-")],
    [sg.ProgressBar(max_value=1, orientation="h", size=(60,20), key="-FAILED-PROGRESS-", bar_color=("red", "#D0D0D0"))],
    [sg.Text("Domain Configuration:", size=(20,1)), sg.Text("", size=(50,1), key="-COMPLETE-PROGRESS-TEXT-")],
    [sg.ProgressBar(max_value=1, orientation="h", size=(60,20), key="-COMPLETE-PROGRESS-")],
    [sg.Multiline(size=(70,15), key="-LOG-", autoscroll=True, reroute_stdout=True, reroute_stderr=True)],
]

window = sg.Window("Smartlead Launcher", layout, size=(800,600), resizable=True, finalize=True)

# Start background processing using process_emails() with progress callback
def start_process(api_key, url, files):
    try:
        # Log for debugging
        print(f"Starting process with {len(files)} files")
        combined = combine_csv_files(files)
        if not combined:
            sg.popup_error("No CSV files selected.")
            window["-RUN-"].update(disabled=False)  # Re-enable the Run button
            return
            
        # Progress callback writes events back to the GUI
        def progress_cb(current, total):
            try:
                window.write_event_value("-PROGRESS-", (current, total))
            except Exception as e:
                print(f"Progress callback error: {e}")
                
        # Failed accounts callback for the red progress bar
        def failed_cb(current, total):
            try:
                window.write_event_value("-FAILED-PROGRESS-", (current, total))
            except Exception as e:
                print(f"Failed accounts callback error: {e}")
                
        # also log stdout back to GUI
        def log_cb(line):
            try:
                window.write_event_value("-LOG-", line)
            except Exception as e:
                print(f"Log callback error: {e}")
                
        # Start processing in a separate thread
        thread = threading.Thread(
            target=lambda: process_with_error_handling(api_key, combined, url, progress_cb, log_cb, failed_cb), 
            daemon=True
        )
        thread.start()
    except Exception as e:
        print(f"Error in start_process: {e}")
        sg.popup_error(f"Error starting process: {e}")
        window["-RUN-"].update(disabled=False)  # Re-enable the Run button

# Wrapper function with error handling
def process_with_error_handling(api_key, csv_path, url, progress_cb, log_cb, failed_cb=None, run_complete=False, domain=None):
    csv_complete_success = False
    try:
        # Check if function accepts log_cb (Windows compatibility)
        import inspect
        sig = inspect.signature(sl_mod.process_emails)
        params = list(sig.parameters.keys())
        
        # Modify the sl-python.py module if parameters are missing
        if len(params) < 6 or 'log_cb' not in params or 'failed_cb' not in params:
            # If the Windows version doesn't have log_cb, add it to the module
            window.write_event_value("-LOG-", "Adding logging support to the module")
            
            # Create a new process_emails function with logging support
            original_process_emails = sl_mod.process_emails
            
            def process_emails_with_logging(api_key, csv_path, url, progress_cb=None, log_cb=None, failed_cb=None):
                # Simple wrapper function that adds logging support
                # Set up stdout redirection for older function
                if log_cb:
                    import sys
                    import io
                    from threading import Timer
                    
                    # Create a custom pipe to capture stdout
                    class LogPipe(io.StringIO):
                        def __init__(self, log_cb):
                            super().__init__()
                            self.log_cb = log_cb
                            self.buffer = ""
                            
                        def write(self, text):
                            self.buffer += text
                            if '\n' in self.buffer:
                                lines = self.buffer.split('\n')
                                for line in lines[:-1]:  # Process all complete lines
                                    if line.strip():  # Only log non-empty lines
                                        try:
                                            self.log_cb(line.strip())
                                        except:
                                            pass
                                self.buffer = lines[-1]  # Keep the last incomplete line
                                
                        def flush(self):
                            if self.buffer:  # Flush any remaining content
                                try:
                                    self.log_cb(self.buffer)
                                    self.buffer = ""
                                except:
                                    pass
                    
                    # Redirect stdout
                    log_pipe = LogPipe(log_cb)
                    old_stdout = sys.stdout
                    sys.stdout = log_pipe
                    
                    # Also log subprocess launch points
                    log_cb("Starting email processing")
                    
                    # Add print statements to help with debugging
                    log_cb(f"Processing {csv_path}")
                    
                    try:
                        # Call the original function with all parameters
                        return original_process_emails(api_key, csv_path, url, progress_cb, log_cb, failed_cb)
                    finally:
                        # Restore stdout and flush any remaining content
                        sys.stdout = old_stdout
                        log_pipe.flush()
                        log_cb("Email processing complete")
                else:
                    # No logging, just call the original function with all parameters
                    return original_process_emails(api_key, csv_path, url, progress_cb, log_cb, failed_cb)
            
            # Replace the function in the module with our wrapped version
            sl_mod.process_emails = process_emails_with_logging
            
        # Now call the function, which should have logging support either way
        failed_csv_path = sl_mod.process_emails(api_key, csv_path, url, progress_cb, log_cb, failed_cb)
        
        # If there's a failed_csv_path, log it
        if failed_csv_path:
            window.write_event_value("-LOG-", f"\n[IMPORTANT] Failed accounts saved to: {failed_csv_path}")
        
        # After successfully processing emails, run the completion script
        window.write_event_value("-LOG-", "\n\nStarting account configuration for all domains in the CSV...")
        
        # Run completion script with the same CSV
        if sl_complete_mod:
            # Run as a module if available (better integration)
            window.write_event_value("-LOG-", "Running completion script as module")
            try:
                # Run the module's main function in a separate thread
                threading.Thread(
                    target=run_complete_module, 
                    args=(api_key, csv_path, log_cb),
                    daemon=True
                ).start()
                csv_complete_success = True
            except Exception as e:
                window.write_event_value("-LOG-", f"Error running completion module: {str(e)}")
        else:
            # Fall back to subprocess if module loading failed
            window.write_event_value("-LOG-", "Running completion script as subprocess")
            try:
                process = subprocess.Popen(
                    [sys.executable, "sl-complete.py", api_key, csv_path],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1  # Line buffered
                )
                
                # Start a thread to read from the process output
                threading.Thread(
                    target=read_process_output,
                    args=(process, log_cb),
                    daemon=True
                ).start()
                csv_complete_success = True
            except Exception as e:
                window.write_event_value("-LOG-", f"Error launching completion script: {str(e)}")
        
        if csv_complete_success:
            window.write_event_value("-LOG-", "Automated completion process started in background")
        else:
            window.write_event_value("-LOG-", "WARNING: Could not start completion script, manual configuration required")
    except Exception as e:
        print(f"Process error: {str(e)}")
        window.write_event_value("-LOG-", f"ERROR: {str(e)}")
        window.write_event_value("-PROCESS-ERROR-", None)

# Function to run the complete module directly
def run_complete_module(api_key, csv_path, log_cb):
    # Create a progress callback for sl-complete.py
    def complete_progress_cb(current, total):
        try:
            window.write_event_value("-COMPLETE-PROGRESS-", (current, total))
        except Exception as e:
            print(f"Complete progress callback error: {e}")
    # Set up stdout redirection if log_cb is provided
    if log_cb:
        import sys
        import io
        
        class LogPipe(io.StringIO):
            def __init__(self, log_cb):
                super().__init__()
                self.log_cb = log_cb
                self.buffer = ""
                
            def write(self, text):
                self.buffer += text
                if '\n' in self.buffer:
                    lines = self.buffer.split('\n')
                    for line in lines[:-1]:
                        if line.strip():
                            try:
                                self.log_cb(line.strip())
                            except:
                                pass
                    self.buffer = lines[-1]
                    
            def flush(self):
                if self.buffer:
                    try:
                        self.log_cb(self.buffer)
                        self.buffer = ""
                    except:
                        pass
        
        # Redirect stdout
        log_pipe = LogPipe(log_cb)
        old_stdout = sys.stdout
        sys.stdout = log_pipe
        
        try:
            # Set sys.argv to simulate command line arguments
            old_argv = sys.argv
            sys.argv = ["sl-complete.py", api_key, csv_path]
            
            # Call the main function with progress callback
            sl_complete_mod.main(complete_progress_cb)
        finally:
            # Restore stdout and sys.argv
            sys.stdout = old_stdout
            sys.argv = old_argv
            log_pipe.flush()
    else:
            # No logging, just run the main function
            old_argv = sys.argv
            sys.argv = ["sl-complete.py", api_key, csv_path]
            try:
                sl_complete_mod.main(complete_progress_cb)
            finally:
                sys.argv = old_argv

# Function to read output from a subprocess
def read_process_output(process, log_cb):
    # Create a simple regex pattern to extract progress information
    import re
    progress_pattern = re.compile(r"Processing account (\d+)/(\d+)")
    for line in iter(process.stdout.readline, ''):
        if not line:  # Empty line means process has ended
            break
            
        line_text = line.strip()
        if log_cb:
            log_cb(line_text)
            
        # Try to extract progress information from the output
        match = progress_pattern.search(line_text)
        if match:
            try:
                current = int(match.group(1))
                total = int(match.group(2))
                window.write_event_value("-COMPLETE-PROGRESS-", (current, total))
            except Exception as e:
                print(f"Error parsing progress: {e}")
    process.stdout.close()
    process.wait()

# Initialize global current_files list to store full paths
current_files = []

# Event loop
while True:
    event, values = window.read()
    if event in (sg.WIN_CLOSED, "Exit"):
        break

    # Add files when files are selected in the browser
    if event == "-FILE-PATH-" and values["-FILE-PATH-"]:
        file_paths = values["-FILE-PATH-"].split(";") if values["-FILE-PATH-"] else []
        
        # Add new files that aren't already in the list (by full path)
        for path in file_paths:
            if path.strip() and path not in current_files:
                current_files.append(path)
        
        # Update the display with basenames only
        window["-FILE-LIST-"].update([os.path.basename(f) for f in current_files])
        window["-FILE-PATH-"].update("")  # Clear the input field
    
    # Clear the file list
    if event == "-CLEAR-LIST-":
        window["-FILE-LIST-"].update([])
        current_files = []  # Clear the global list of file paths
        window["-LOG-"].update("")  # Clear log too

    # Run button pressed
    if event == "-RUN-":
        try:
            api_key = values["-API-KEY-"].strip()
            url = values["-URL-"].strip()
            
            # Get the actual file paths, not just display names
            display_names = window["-FILE-LIST-"].get_list_values()
            file_paths = []
            
            # Retrieve the actual paths from what we stored when adding files
            for path in current_files:
                if os.path.basename(path) in display_names and path not in file_paths:
                    file_paths.append(path)
            
            if not (api_key and url and file_paths):
                sg.popup_error("Please fill API Key, Login URL, and select CSV files.")
                continue
                
            window["-RUN-"].update(disabled=True)
            window["-LOG-"].update("Starting process...\n")
            window["-PROGRESS-TEXT-"].update("Initializing...")
            window.refresh()  # Show starting message immediately
            
            # Launch the processing
            start_process(api_key, url, file_paths)
        except Exception as e:
            sg.popup_error(f"Error: {str(e)}")
            window["-RUN-"].update(disabled=False)

    # Progress update event
    if event == "-PROGRESS-":
        try:
            current, total = values[event]
            window["-PROGRESS-"].update(current_count=current, max=total)
            window["-PROGRESS-TEXT-"].update(f"Progress: {current} of {total} accounts processed ({int(current/total*100)}%)")
            if current >= total:
                window["-RUN-"].update(disabled=False)
        except Exception as e:
            print(f"Error updating progress: {e}")
            
    # Failed accounts progress update event
    if event == "-FAILED-PROGRESS-":
        try:
            current, total = values[event]
            window["-FAILED-PROGRESS-"].update(current_count=current, max=total)
            window["-FAILED-PROGRESS-TEXT-"].update(f"Failed: {current} of {total} accounts failed ({int(current/total*100 if total > 0 else 0)}%)")
        except Exception as e:
            print(f"Error updating failed progress: {e}")
            
    # Complete script progress update event
    if event == "-COMPLETE-PROGRESS-":
        try:
            current, total = values[event]
            window["-COMPLETE-PROGRESS-"].update(current_count=current, max=total)
            window["-COMPLETE-PROGRESS-TEXT-"].update(f"Progress: {current} of {total} accounts configured ({int(current/total*100)}%)")
            if current >= total:
                # Use non-blocking notification instead of popup
                window["-LOG-"].print("\n[COMPLETE] All processing complete!")
                window.refresh()
        except Exception as e:
            print(f"Error updating complete progress: {e}")
    
    # Handle process errors
    if event == "-PROCESS-ERROR-":
        window["-RUN-"].update(disabled=False)

    if event == "-LOG-":
        # Add timestamps to log messages
        from datetime import datetime
        timestamp = datetime.now().strftime("%H:%M:%S")
        window["-LOG-"].print(f"[{timestamp}] {values[event]}")

window.close()
