#!/usr/bin/env python3
"""
Configuration file for Instantly Uploader
Adjust these settings as needed
"""

# Number of parallel workers (default: 3, max recommended: 5)
NUM_WORKERS = 3

# Delay between accounts (seconds)
MIN_DELAY_BETWEEN_ACCOUNTS = 3
MAX_DELAY_BETWEEN_ACCOUNTS = 8

# Retry settings
MAX_RETRIES_PER_ACCOUNT = 3

# Timeout settings (seconds)
PAGE_LOAD_TIMEOUT = 15
ELEMENT_WAIT_TIMEOUT = 10

# Chrome driver settings
CHROME_HEADLESS = True  # Set to False for debugging
CHROME_WINDOW_SIZE = "1920,1080"

# API settings
INSTANTLY_API_BASE_URL = "https://api.instantly.ai/api/v1"
MAX_ACCOUNTS_TO_FETCH = 9999

# File settings
FAILED_ACCOUNTS_PREFIX = "failed_accounts"
TEMP_DIR_PREFIX = "instantly_temp_"

# Debug mode (more verbose output)
DEBUG_MODE = False