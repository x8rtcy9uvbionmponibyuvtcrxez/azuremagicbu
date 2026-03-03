import random
import string
import sys
import csv
from typing import List, Dict
from datetime import datetime
import os
import requests
import json

# Get the directory where this script is located
script_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(script_dir, '.env')

# Function to load .env file manually (fallback if python-dotenv not installed)
def load_env_file(env_file_path):
    """Load environment variables from .env file manually"""
    if os.path.exists(env_file_path):
        with open(env_file_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ[key.strip()] = value.strip()

# Try to use python-dotenv if available, otherwise use manual loader
try:
    from dotenv import load_dotenv
    load_dotenv(env_path)
except ImportError:
    load_env_file(env_path)

def generate_password(length: int = 12) -> str:
    """Generate a random password that meets Microsoft's complexity requirements."""
    if length < 8:
        raise ValueError("Password length must be at least 8 characters.")

    # Ensure password complexity
    categories = [
        random.choice(string.ascii_uppercase),  # At least one uppercase letter
        random.choice(string.ascii_lowercase),  # At least one lowercase letter
        random.choice(string.digits),           # At least one digit
        random.choice("!@#$%^&*()")              # At least one special character
    ]

    # Fill the remaining length with a mix of all character types
    all_characters = string.ascii_letters + string.digits + "!@#$%^&*()"
    categories.extend(random.choices(all_characters, k=length - len(categories)))

    # Shuffle to avoid predictable patterns
    random.shuffle(categories)
    return ''.join(categories)

def get_base_variations(first: str, last: str) -> List[str]:
    """
    Get all base variations for a single name in prioritized order.
    The full first name is prioritized first. Variations that use abbreviations
    (such as first or last initials) are placed later.
    """
    patterns = []
    # 1. Full first name only.
    patterns.append(first)

    # 2. Full first name + full last name with various separators.
    patterns.append(first + last)
    patterns.append(f"{first}.{last}")
    patterns.append(f"{first}_{last}")
    patterns.append(f"{first}-{last}")

    # 3. Full first name + abbreviated last (first letter of last).
    if last:
        last_initial = last[0]
        patterns.append(first + last_initial)
        patterns.append(f"{first}.{last_initial}")
        patterns.append(f"{first}_{last_initial}")
        patterns.append(f"{first}-{last_initial}")

    # 4. Variations that start with last name but end with full first name.
    patterns.append(last + first)
    patterns.append(f"{last}.{first}")
    patterns.append(f"{last}_{first}")
    patterns.append(f"{last}-{first}")

    # 5. Variations using abbreviated first (first letter) with full last.
    first_initial = first[0]
    patterns.append(first_initial + last)
    patterns.append(f"{first_initial}.{last}")
    patterns.append(f"{first_initial}_{last}")
    patterns.append(f"{first_initial}-{last}")

    # 6. Variations with full last followed by abbreviated first.
    patterns.append(last + first_initial)
    patterns.append(f"{last}.{first_initial}")
    patterns.append(f"{last}_{first_initial}")
    patterns.append(f"{last}-{first_initial}")

    # 7. Variations using both initials.
    patterns.append(first_initial + (last[0] if last else ""))
    patterns.append(f"{first_initial}.{last[0] if last else ''}")
    patterns.append(f"{first_initial}_{last[0] if last else ''}")
    patterns.append(f"{first_initial}-{last[0] if last else ''}")
    patterns.append((last[0] if last else "") + first_initial)
    patterns.append(f"{last[0] if last else ''}.{first_initial}")
    patterns.append(f"{last[0] if last else ''}_{first_initial}")
    patterns.append(f"{last[0] if last else ''}-{first_initial}")

    # 8. Finally, just the last name (lowest priority).
    patterns.append(last)

    # Remove duplicates while preserving order.
    seen = set()
    unique_patterns = []
    for pattern in patterns:
        if pattern not in seen:
            seen.add(pattern)
            unique_patterns.append(pattern)
    return unique_patterns

def generate_letter_variations(first: str, last: str, required_count: int) -> List[str]:
    """Generate additional variations with random letters until reaching required count."""
    variations = []
    letters = list(string.ascii_lowercase)
    random.shuffle(letters)

    for letter in letters:
        for pattern in [
            f"{first}{letter}",
            f"{last}{letter}",
            f"{first}{last}{letter}",
            f"{first}.{last}{letter}",
            f"{first}_{last}{letter}",
            f"{last}_{first}{letter}",
            f"{last}.{first}{letter}"
        ]:
            if pattern not in variations:
                variations.append(pattern)
                if len(variations) >= required_count:
                    return variations

    if len(variations) < required_count:
        for letter1 in letters:
            for letter2 in letters[:2]:
                for pattern in [
                    f"{first}{letter1}{letter2}",
                    f"{last}{letter1}{letter2}",
                    f"{first}{last}{letter1}{letter2}"
                ]:
                    if pattern not in variations:
                        variations.append(pattern)
                        if len(variations) >= required_count:
                            return variations

    return variations

def generate_email_variations(names: List[str], domain: str) -> Dict[str, List[str]]:
    """Generate email variations based on provided names."""
    variations_map = {}
    total_needed = 99
    num_names = len(names)
    all_variations = set()  # To ensure uniqueness across names

    # Calculate variations needed per name.
    base_variations_per_name = total_needed // num_names
    extra_variations = total_needed % num_names
    variations_needed = [base_variations_per_name] * num_names
    for i in range(extra_variations):
        variations_needed[i] += 1

    def add_random_suffix(pattern: str) -> str:
        """Add random letters (no numbers) to make the email unique."""
        suffix = ''.join(random.choices(string.ascii_lowercase, k=2))
        return f"{pattern}{suffix}"

    for name, num_variations in zip(names, variations_needed):
        display_name = name
        parts = name.lower().split()
        first = parts[0]
        # Join all remaining parts to support multi-word last names
        last = "".join(parts[1:])
        name_variations = []  # Use list to preserve generation order

        # Generate base patterns in prioritized order.
        for pattern in get_base_variations(first, last):
            email = f"{pattern}@{domain}"
            if email not in all_variations:
                name_variations.append(email)
                all_variations.add(email)
            else:
                # If duplicate found, add random suffix until unique.
                while True:
                    new_pattern = add_random_suffix(pattern)
                    email = f"{new_pattern}@{domain}"
                    if email not in all_variations:
                        name_variations.append(email)
                        all_variations.add(email)
                        break
            if len(name_variations) >= num_variations:
                break

        # If we still need more variations, generate them with random letters.
        if len(name_variations) < num_variations:
            extra_patterns = generate_letter_variations(first, last, num_variations - len(name_variations) + 10)
            for pattern in extra_patterns:
                email = f"{pattern}@{domain}"
                if email not in all_variations:
                    name_variations.append(email)
                    all_variations.add(email)
                else:
                    while len(name_variations) < num_variations:
                        new_pattern = add_random_suffix(pattern)
                        email = f"{new_pattern}@{domain}"
                        if email not in all_variations:
                            name_variations.append(email)
                            all_variations.add(email)
                            break
                if len(name_variations) >= num_variations:
                    break

        # Keep only the first num_variations in the order generated.
        variations_map[display_name] = name_variations[:num_variations]

    return variations_map

def save_to_csv(variations_map: Dict[str, List[str]], filename: str):
    """Save the generated emails and passwords to a CSV file."""
    with open(filename, 'w', newline='', encoding='utf-8') as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(['DisplayName', 'EmailAddress', 'Password'])
        # Write rows in the order generated.
        for display_name, variations in variations_map.items():
            for email in variations:
                writer.writerow([display_name, email, generate_password()])

def upload_file_to_airtable(record_id, file_path, field_name="CSV File"):
    """
    Note: Airtable requires a publicly accessible URL for file uploads.
    Direct base64 uploads are not supported by Airtable's API.

    This function is a placeholder for future implementation with a file hosting service.
    For now, users must manually upload the CSV file to Airtable.
    """
    print("\nNote: Airtable API does not support direct file uploads without a public URL.")
    print("The CSV file has been saved locally and can be manually uploaded to Airtable.")
    print(f"File location: {file_path}")
    return True

def main():
    try:
        # Tenant number
        tenant = sys.argv[1]
        # Domain
        domain = sys.argv[2]
        # Comma-separated list of full names.
        names_input = sys.argv[3]
        # Airtable Record ID (replaces monday.com item ID)
        record_id = sys.argv[4]

        names = [alias.strip() for alias in names_input.split(",") if alias.strip()]

        # Validate each alias has at least a first and last name.
        for name in names:
            if len(name.split()) < 2:
                print(f"Invalid alias format: '{name}'. Expected format: 'FirstName LastName'.")
                sys.exit(1)

        variations_map = generate_email_variations(names, domain)

        total_count = sum(len(variations) for variations in variations_map.values())
        if total_count != 99:
            print(f"Error: Generated {total_count} variations instead of 99")
            sys.exit(1)

        # Filename formatted as "(Tenant ID) - domainName.csv"
        domain_name = domain.rsplit('.', 1)[0]
        filename = f"{tenant} - {domain_name}.csv"

        # Check if CSV's folder exists, create if not
        output_folder = r"C:\Users\Administrator\Desktop\CSV's"
        if not os.path.exists(output_folder):
            print(f"CSV's folder not found. Creating: {output_folder}")
            try:
                os.makedirs(output_folder)
                print(f"Created folder: {output_folder}")
            except Exception as e:
                print(f"Error creating folder: {e}")
                print("Using Desktop as fallback location")
                output_folder = r"C:\Users\Administrator\Desktop"

        filepath = os.path.join(output_folder, filename)
        save_to_csv(variations_map, filepath)

        print(f"\nResults saved to: {filepath}")
        print(f"Total variations generated: {total_count}")

        for display_name, variations in variations_map.items():
            print(f"\nSample variations for {display_name}:")
            print("-" * 50)
            print(f"Number of variations: {len(variations)}")
            for email in variations[:5]:
                print(email)
            print("...")

        # Note about CSV file location
        print("\n" + "=" * 50)
        print("CSV FILE READY")
        print("=" * 50)
        print(f"Location: {filepath}")
        print("\nThe CSV file is ready to use with script2_nov.ps1")
        print("You can also manually upload it to Airtable if needed.")

    except KeyboardInterrupt:
         print("\nProgram terminated by user.")
         sys.exit(0)
    except Exception as e:
         print(f"An error occurred: {e}")
         sys.exit(1)

if __name__ == "__main__":
    main()
