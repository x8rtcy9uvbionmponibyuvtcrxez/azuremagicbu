#!/usr/bin/env python3
"""
fill_credentials.py - Interactive .env file generator
This script prompts the user for all necessary credentials and creates a .env file
"""

import os
import sys

def print_header():
    """Print script header"""
    print("=" * 80)
    print("Environment Configuration Setup")
    print("=" * 80)
    print()
    print("This script will help you create a .env file with all required credentials.")
    print("Press Enter to skip optional fields.")
    print()

def print_section(title):
    """Print section header"""
    print()
    print("-" * 80)
    print(f"{title}")
    print("-" * 80)

def get_input(prompt, required=True):
    """Get user input"""
    while True:
        value = input(f"{prompt}: ").strip()

        if value or not required:
            return value
        else:
            print("  [ERROR] This field is required. Please enter a value.")

def confirm_overwrite(filepath):
    """Ask user to confirm overwriting existing .env file"""
    if os.path.exists(filepath):
        print()
        print(f"WARNING: {filepath} already exists!")
        response = input("Do you want to overwrite it? (yes/no): ").strip().lower()
        return response in ['yes', 'y']
    return True

def main():
    print_header()

    # Determine .env file location (same directory as script)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    env_file_path = os.path.join(script_dir, ".env")

    print(f"The .env file will be created at:")
    print(f"  {env_file_path}")
    print()

    # Check if file exists and confirm overwrite
    if not confirm_overwrite(env_file_path):
        print()
        print("Operation cancelled. No changes were made.")
        sys.exit(0)

    # Collect credentials
    credentials = {}

    # ========================================
    # Airtable Configuration
    # ========================================
    print_section("Airtable Configuration")
    print("To get your Airtable credentials:")
    print("1. Go to https://airtable.com/account")
    print("2. Generate a personal access token")
    print("3. Copy your Base ID from the URL (e.g., appXXXXXXXXXXXXXX)")
    print()
    print("TIP: Use Control + V (or Cmd + V on Mac) to paste")
    print()

    credentials['AIRTABLE_API_KEY'] = get_input(
        "Enter your Airtable API Key/Personal Access Token",
        required=True
    )

    credentials['AIRTABLE_BASE_ID'] = get_input(
        "Enter your Airtable Base ID (e.g., appXXXXXXXXXXXXXX)",
        required=True
    )

    credentials['AIRTABLE_TABLE_NAME'] = get_input(
        "Enter your Airtable Table Name [default: Tenants]",
        required=False
    ) or "Tenants"

    # ========================================
    # Cloudflare Configuration
    # ========================================
    print_section("Cloudflare Configuration")
    print("To get your Cloudflare credentials:")
    print("1. Go to https://dash.cloudflare.com/profile/api-tokens")
    print("2. Use 'Global API Key' or create a new API token")
    print("3. Use the email associated with your Cloudflare account")
    print()
    print("TIP: Use Control + V (or Cmd + V on Mac) to paste")
    print()

    credentials['CLOUDFLARE_API_KEY'] = get_input(
        "Enter your Cloudflare API Key",
        required=True
    )

    credentials['CLOUDFLARE_EMAIL'] = get_input(
        "Enter your Cloudflare account email",
        required=True
    )

    # ========================================
    # Microsoft Graph Configuration
    # ========================================
    print_section("Microsoft Graph Configuration")
    print("To get your Microsoft Graph credentials:")
    print("1. Go to https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade")
    print("2. Create a new App Registration (or use existing)")
    print("3. Copy the 'Application (client) ID' from the Overview page")
    print("4. Go to 'Certificates & secrets' and create a new client secret")
    print("5. Copy the client secret VALUE (not the secret ID)")
    print()
    print("TIP: Use Control + V (or Cmd + V on Mac) to paste")
    print()

    credentials['GRAPH_APP_ID'] = get_input(
        "Enter your Microsoft Graph App ID (Application ID)",
        required=True
    )

    credentials['GRAPH_CLIENT_ID'] = get_input(
        "Enter your Microsoft Graph Client ID [default: same as App ID]",
        required=False
    ) or credentials['GRAPH_APP_ID']

    credentials['GRAPH_CLIENT_SECRET'] = get_input(
        "Enter your Microsoft Graph Client Secret",
        required=True
    )

    # ========================================
    # Create .env file
    # ========================================
    print_section("Creating .env file")

    try:
        # Ensure directory exists
        env_dir = os.path.dirname(env_file_path)
        if not os.path.exists(env_dir):
            os.makedirs(env_dir)
            print(f"Created directory: {env_dir}")

        # Write .env file
        with open(env_file_path, 'w') as f:
            f.write("# Airtable Configuration\n")
            f.write(f"AIRTABLE_API_KEY={credentials['AIRTABLE_API_KEY']}\n")
            f.write(f"AIRTABLE_BASE_ID={credentials['AIRTABLE_BASE_ID']}\n")
            f.write(f"AIRTABLE_TABLE_NAME={credentials['AIRTABLE_TABLE_NAME']}\n")
            f.write("\n")
            f.write("# Cloudflare Configuration\n")
            f.write(f"CLOUDFLARE_API_KEY={credentials['CLOUDFLARE_API_KEY']}\n")
            f.write(f"CLOUDFLARE_EMAIL={credentials['CLOUDFLARE_EMAIL']}\n")
            f.write("\n")
            f.write("# Microsoft Graph Configuration\n")
            f.write(f"GRAPH_APP_ID={credentials['GRAPH_APP_ID']}\n")
            f.write(f"GRAPH_CLIENT_ID={credentials['GRAPH_CLIENT_ID']}\n")
            f.write(f"GRAPH_CLIENT_SECRET={credentials['GRAPH_CLIENT_SECRET']}\n")

        print()
        print("[OK] .env file created successfully!")
        print(f"     Location: {env_file_path}")

    except Exception as e:
        print()
        print(f"[ERROR] Failed to create .env file: {e}")
        sys.exit(1)

    # ========================================
    # Summary
    # ========================================
    print()
    print("=" * 80)
    print("Configuration Summary")
    print("=" * 80)
    print(f"Airtable API Key:           {credentials['AIRTABLE_API_KEY']}")
    print(f"Airtable Base ID:           {credentials['AIRTABLE_BASE_ID']}")
    print(f"Airtable Table Name:        {credentials['AIRTABLE_TABLE_NAME']}")
    print(f"Cloudflare API Key:         {credentials['CLOUDFLARE_API_KEY']}")
    print(f"Cloudflare Email:           {credentials['CLOUDFLARE_EMAIL']}")
    print(f"Microsoft Graph App ID:     {credentials['GRAPH_APP_ID']}")
    print(f"Microsoft Graph Client ID:  {credentials['GRAPH_CLIENT_ID']}")
    print(f"Microsoft Graph Secret:     {credentials['GRAPH_CLIENT_SECRET']}")
    print()
    print("=" * 80)
    print("Next Steps")
    print("=" * 80)
    print("1. Your .env file is ready to use with all scripts!")
    print()
    print("2. PowerShell scripts can use: Import-Module ./CredentialModule.psm1")
    print()
    print("3. Python scripts will automatically load credentials from .env")
    print()
    print("IMPORTANT: Keep your .env file secure and never commit it to version control!")
    print()

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nOperation cancelled by user.")
        sys.exit(0)
    except Exception as e:
        print(f"\n[ERROR] Unexpected error: {e}")
        sys.exit(1)
