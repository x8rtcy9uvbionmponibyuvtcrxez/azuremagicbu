import tkinter as tk
from tkinter import ttk
import threading
import subprocess
import sys
import json

class Section(ttk.Frame):
    def __init__(self, parent, section_number):
        super().__init__(parent)
        
        # Section title
        self.section_label = ttk.Label(self, text=f"Section {section_number}", font=("Helvetica", 14, "bold"))
        self.section_label.grid(row=0, column=0, columnspan=2, pady=(5, 10))
        
        # Tenant Name Input (using tk.Entry so we can update its highlight easily)
        ttk.Label(self, text="Tenant Name:").grid(row=1, column=0, padx=5, pady=5, sticky="e")
        self.tenant_entry = tk.Entry(self, width=30)
        self.tenant_entry.grid(row=1, column=1, padx=5, pady=5, sticky="w")
        # Bind key release event to remove error highlight if user enters text
        self.tenant_entry.bind("<KeyRelease>", self.on_key_release)
        
        # Run Button (moved up as status labels are removed)
        self.run_button = ttk.Button(self, text="Run", command=self.run_check)
        self.run_button.grid(row=2, column=0, columnspan=2, pady=10)
        
    def on_key_release(self, event):
        # When user types, if the tenant name is not empty, remove the red highlight
        if self.tenant_entry.get().strip():
            self.tenant_entry.config(highlightthickness=0)
        
    def run_check(self):
        tenant_name = self.tenant_entry.get().strip()
        if tenant_name == "":
            self.tenant_entry.config(highlightthickness=2, highlightbackground="red", highlightcolor="red")
            return

        self.tenant_entry.config(highlightthickness=0)
        # Execute script1_run.py in a background thread, passing the tenant name
        thread = threading.Thread(target=self.execute_script, args=(tenant_name,))
        thread.start()
        
    def execute_script(self, tenant_name):
        # Build a command to execute script1_run.py with tenant_name as argument
        cmd = [sys.executable, "script1_run.py", tenant_name]
        try:
            subprocess.run(cmd, check=True)
            # Upon success, call complete_check
            self.after(0, self.complete_check)
        except subprocess.CalledProcessError as e:
            # On failure, print error message
            print('Script execution failed:', e)
        
    def complete_check(self):
        # Direct status update removed; statuses are updated via polling of status_update.json
        pass

class App:
    def __init__(self, root):
        self.root = root
        self.root.title("Script 1 Input Form")
        
        # Create first section
        self.section1 = Section(root, section_number=1)
        self.section1.pack(padx=10, pady=10, fill="x")
        
        # Create second identical section
        self.section2 = Section(root, section_number=2)
        self.section2.pack(padx=10, pady=10, fill="x")

def main():
    root = tk.Tk()
    app = App(root)
    root.mainloop()

if __name__ == "__main__":
    main()
