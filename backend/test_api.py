#!/usr/bin/env python3
"""
API Test Suite for Knowledge IDE Backend

Tests all endpoints without requiring a full database setup.
"""
import requests
import json
import time
from pathlib import Path

BASE_URL = "http://localhost:8000"


def print_section(name):
    print(f"\n{'='*50}")
    print(f"  {name}")
    print('='*50)


def test_health():
    print_section("Health Check")
    response = requests.get(f"{BASE_URL}/health")
    print(f"GET /health")
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


def test_upload_file():
    print_section("File Upload")

    # Create test file
    test_content = """# Knowledge IDE Test Document

This is a comprehensive test document.

## Chapter 1: Introduction

The Knowledge IDE is a next-generation note-taking application that integrates AI capabilities.

## Chapter 2: Features

- Block-based editing
- PDF parsing
- Vector search
- AI chat completion

## Chapter 3: Conclusion

This system represents the future of knowledge management.
"""

    files = {
        'file': ('test_document.md', test_content, 'text/markdown')
    }

    print(f"POST /api/v1/files/upload")
    response = requests.post(f"{BASE_URL}/api/v1/files/upload", files=files)
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    file_id = data["data"]["file_id"]
    print(f"\n[OK] File uploaded successfully with ID: {file_id}")
    return file_id


def test_list_files(file_id=None):
    print_section("List Files")
    response = requests.get(f"{BASE_URL}/api/v1/files/")
    print(f"GET /api/v1/files/")
    print(f"Status: {response.status_code}")
    data = response.json()
    print(f"Files count: {len(data['data']['files'])}")
    if data['data']['files']:
        print(f"First file: {data['data']['files'][0]['name']}")


def test_get_file(file_id):
    print_section("Get File Metadata")
    response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}")
    print(f"GET /api/v1/files/{file_id}")
    print(f"Status: {response.status_code}")
    data = response.json()
    print(f"File name: {data['data']['name']}")
    print(f"File type: {data['data']['type']}")
    print(f"File size: {data['data']['size']} bytes")


def test_get_file_content(file_id):
    print_section("Get File Content")
    response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}/content")
    print(f"GET /api/v1/files/{file_id}/content")
    print(f"Status: {response.status_code}")
    data = response.json()
    content = data['data']['content']
    print(f"Content preview: {content[:100]}...")


def test_get_chunks(file_id):
    print_section("Get Document Chunks")
    response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}/chunks")
    print(f"GET /api/v1/files/{file_id}/chunks")
    print(f"Status: {response.status_code}")
    data = response.json()
    chunks = data['data']['chunks']
    print(f"Number of chunks: {len(chunks)}")
    if chunks:
        print(f"First chunk: {chunks[0]['content'][:50]}...")


def test_chat_completion(file_id):
    print_section("Chat Completion")

    payload = {
        "session_id": "test-session-123",
        "message": "Summarize the document",
        "context_files": [file_id]
    }

    print(f"POST /api/v1/chat/completions")
    print(f"Message: {payload['message']}")
    response = requests.post(
        f"{BASE_URL}/api/v1/chat/completions",
        json=payload
    )
    print(f"Status: {response.status_code}")
    data = response.json()
    print(f"Response: {data['data']['content']}")
    print(f"Citations: {len(data['data'].get('citations', []))}")

    return "test-session-123"


def test_get_session(session_id):
    print_section("Get Session")
    response = requests.get(f"{BASE_URL}/api/v1/chat/sessions/{session_id}")
    print(f"GET /api/v1/chat/sessions/{session_id}")
    print(f"Status: {response.status_code}")
    data = response.json()
    print(f"Session ID: {data['data']['id']}")
    print(f"Session name: {data['data']['name']}")


def test_get_session_messages(session_id):
    print_section("Get Session Messages")
    response = requests.get(f"{BASE_URL}/api/v1/chat/sessions/{session_id}/messages")
    print(f"GET /api/v1/chat/sessions/{session_id}/messages")
    print(f"Status: {response.status_code}")
    data = response.json()
    messages = data['data']['messages']
    print(f"Message count: {len(messages)}")
    for msg in messages:
        print(f"  - {msg['role']}: {msg['content'][:50]}...")


def test_update_permissions(session_id, file_id):
    print_section("Update Permissions")

    payload = {
        "file_id": file_id,
        "permission": "write"
    }

    response = requests.post(
        f"{BASE_URL}/api/v1/chat/sessions/{session_id}/permissions",
        params=payload
    )
    print(f"POST /api/v1/chat/sessions/{session_id}/permissions")
    print(f"Status: {response.status_code}")
    data = response.json()
    print(f"Permission updated: {data['data']}")


def test_websocket_status():
    print_section("WebSocket Status")
    response = requests.get(f"{BASE_URL}/api/v1/ws/status")
    print(f"GET /api/v1/ws/status")
    print(f"Status: {response.status_code}")
    data = response.json()
    print(f"Active sessions: {data['active_sessions']}")
    print(f"Total connections: {data['total_connections']}")


def test_delete_file(file_id):
    print_section("Delete File")
    response = requests.delete(f"{BASE_URL}/api/v1/files/{file_id}")
    print(f"DELETE /api/v1/files/{file_id}")
    print(f"Status: {response.status_code}")
    data = response.json()
    print(f"Message: {data['data']['message']}")


def run_all_tests():
    print("\n" + "="*50)
    print("  Knowledge IDE API Test Suite")
    print("="*50)

    try:
        # Health check
        test_health()

        # File operations
        file_id = test_upload_file()
        test_list_files()
        test_get_file(file_id)
        test_get_file_content(file_id)
        test_get_chunks(file_id)

        # Chat operations
        session_id = test_chat_completion(file_id)
        test_get_session(session_id)
        test_get_session_messages(session_id)
        test_update_permissions(session_id, file_id)

        # WebSocket status
        test_websocket_status()

        # Cleanup
        test_delete_file(file_id)

        print("\n" + "="*50)
        print("  [OK] All tests passed!")
        print("="*50 + "\n")

    except AssertionError as e:
        print(f"\n[FAIL] Test failed: {e}")
    except requests.exceptions.ConnectionError:
        print("\n[FAIL] Could not connect to server. Is it running on http://localhost:8000?")
    except Exception as e:
        print(f"\n[FAIL] Unexpected error: {e}")


if __name__ == "__main__":
    run_all_tests()
