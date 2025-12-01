#!/bin/sh
set -e

# Function to handle shutdown
shutdown() {
    echo "Shutting down gracefully..."
    kill -TERM "$main_pid" "$worker_pid" 2>/dev/null || true
    wait "$main_pid" "$worker_pid"
    exit 0
}

# Trap SIGTERM and SIGINT
trap shutdown TERM INT

echo "Starting main application..."
bun start &
main_pid=$!

echo "Starting resize worker..."
bun run resize:worker:prod &
worker_pid=$!

# Wait for any process to exit
wait -n

# Exit with status of process that exited first
exit_status=$?
echo "Process exited with status $exit_status"
shutdown