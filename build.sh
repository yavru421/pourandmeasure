#!/bin/bash
set -e

# Clean old output to prevent stale files
rm -rf output

# Copy the static assets straight to output
mkdir -p output
cp -r wwwroot output/
