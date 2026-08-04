#!/usr/bin/env python3
"""
Download Bitcoin historical data from Kaggle.

Usage:
  export KAGGLE_API_TOKEN=KGAT_ac4d504abb0f26b9ba6e8aa2d9e425c3
  python3 scripts/download_kaggle_btc.py

Requirements:
  pip install kagglehub pandas
"""
import os
import sys

# Ensure API token is set
token = os.environ.get("KAGGLE_API_TOKEN")
if not token:
    print("ERROR: Set KAGGLE_API_TOKEN environment variable first.")
    print("  export KAGGLE_API_TOKEN=KGAT_ac4d504abb0f26b9ba6e8aa2d9e425c3")
    sys.exit(1)

try:
    import kagglehub
    from kagglehub import KaggleDatasetAdapter
except ImportError:
    print("Installing kagglehub...")
    os.system(f"{sys.executable} -m pip install kagglehub pandas")
    import kagglehub
    from kagglehub import KaggleDatasetAdapter

DATASET = "mczielinski/bitcoin-historical-data"
# The dataset contains: bitstampUSD_1-min_data_2012-01-01_to_2021-03-31.csv
# and btcusd_1-min_data.csv (updated)
FILE_PATH = "btcusd_1-min_data.csv"

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "data", "kaggle")
os.makedirs(OUTPUT_DIR, exist_ok=True)

print(f"Downloading dataset: {DATASET}")
print(f"File: {FILE_PATH}")
print()

# Load as pandas dataframe
df = kagglehub.load_dataset(
    KaggleDatasetAdapter.PANDAS,
    DATASET,
    FILE_PATH,
)

print(f"Loaded {len(df):,} rows")
print(f"Columns: {list(df.columns)}")
print(f"\nFirst 5 records:\n{df.head()}")
print(f"\nLast 5 records:\n{df.tail()}")
print(f"\nDate range: {df.iloc[0]['Timestamp'] if 'Timestamp' in df.columns else 'N/A'} to {df.iloc[-1]['Timestamp'] if 'Timestamp' in df.columns else 'N/A'}")

# Save to output
output_path = os.path.join(OUTPUT_DIR, "btcusd_1-min_data.csv")
df.to_csv(output_path, index=False)
print(f"\nSaved to: {output_path}")
print(f"File size: {os.path.getsize(output_path) / (1024*1024):.1f} MB")
