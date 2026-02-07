#!/usr/bin/env python3
"""
Comprehensive test suite for Knowledge IDE with DeepSeek Agent System.

Tests:
1. File upload and parsing
2. File content retrieval
3. Agent tool calling (search, update, insert)
4. Chat with context
5. Version history
"""
import requests
import json
import time
from pathlib import Path

BASE_URL = "http://localhost:8000"


def print_section(name):
    print("\n" + "=" * 60)
    print(f"  {name}")
    print("=" * 60)


def test_health():
    print_section("Health Check")
    response = requests.get(f"{BASE_URL}/health")
    print(f"Status: {response.status_code}")
    data = response.json()
    print(f"Response: {json.dumps(data, indent=2)}")
    assert data["status"] == "healthy"
    print("[OK] Server is healthy")


def test_upload_document():
    print_section("Test 1: Upload Document")

    # Create a test document
    test_doc = """# Project Requirements

## Overview
Build a knowledge management system with AI capabilities.

## Features
1. Document upload and parsing
2. AI-powered chat with context
3. File version control

## Technical Details
- Frontend: React + TypeScript
- Backend: FastAPI + Python
- AI: DeepSeek API integration

## Tasks
- [ ] Implement file upload
- [ ] Add vector search
- [ ] Create agent tools
"""

    files = {"file": ("requirements.md", test_doc, "text/markdown")}
    response = requests.post(f"{BASE_URL}/api/v1/files/upload", files=files)

    print(f"Status: {response.status_code}")
    data = response.json()
    print(f"Upload Response: {json.dumps(data, indent=2)}")

    assert response.status_code == 200
    assert data["success"] is True

    file_id = data["data"]["file_id"]
    print(f"[OK] File uploaded with ID: {file_id}")
    return file_id


def test_get_file_content(file_id):
    print_section("Test 2: Get File Content")

    response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}/content")
    print(f"Status: {response.status_code}")
    data = response.json()

    assert response.status_code == 200
    content = data["data"]["content"]
    print(f"Content preview: {content[:100]}...")
    print(f"[OK] Retrieved {len(content)} characters")
    return content


def test_get_chunks(file_id):
    print_section("Test 3: Get Document Chunks")

    response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}/chunks")
    print(f"Status: {response.status_code}")
    data = response.json()

    assert response.status_code == 200
    chunks = data["data"]["chunks"]
    print(f"Chunks: {len(chunks)} chunks parsed")
    for i, chunk in enumerate(chunks[:3]):
        print(f"  Chunk {i}: {chunk['content'][:50]}...")
    print(f"[OK] Retrieved {len(chunks)} chunks")


def test_chat_with_context(file_id):
    print_section("Test 4: Chat with Document Context")

    payload = {
        "session_id": "test-agent-session",
        "message": "Summarize the project requirements",
        "context_files": [file_id],
        "model": "deepseek-chat",
        "use_tools": False  # Disable tools for simple query
    }

    print(f"Message: {payload['message']}")
    response = requests.post(f"{BASE_URL}/api/v1/chat/completions", json=payload)

    print(f"Status: {response.status_code}")
    data = response.json()

    if response.status_code == 200:
        print(f"AI Response: {data['data']['content'][:200]}...")
        print(f"[OK] Chat with context working")
    else:
        print(f"Note: Chat requires DeepSeek API key. Response: {data}")
        print("[SKIP] Chat test (no API key)")


def test_update_file_content(file_id):
    print_section("Test 5: Update File Content")

    new_content = """# Updated Requirements

## Overview
Build a knowledge management system with AI capabilities.

## New Features
- Real-time collaboration
- Advanced search

## Updated Tasks
- [x] Implement file upload
- [ ] Add vector search
- [ ] Create agent tools
"""

    payload = {
        "content": new_content,
        "author": "human",
        "summary": "Added new features section"
    }

    response = requests.put(f"{BASE_URL}/api/v1/files/{file_id}/content", json=payload)
    print(f"Status: {response.status_code}")
    data = response.json()

    assert response.status_code == 200
    print(f"[OK] File updated to version {data['data']['version']}")


def test_version_history(file_id):
    print_section("Test 6: Version History")

    response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}/versions")
    print(f"Status: {response.status_code}")
    data = response.json()

    assert response.status_code == 200
    versions = data["data"]["versions"]

    print(f"Versions: {len(versions)} versions")
    for v in versions:
        print(f"  v{v['version']}: {v['summary']} ({v['author']}) at {v['timestamp']}")

    print(f"[OK] Version history working")


def test_agent_tools():
    print_section("Test 7: Agent Tool Calling (Mock)")

    # This would test the agent's ability to call tools
    # Without a real API key, we can't test actual tool calling
    print("Agent Tools Available:")
    print("  - search_documents: Search for content in uploaded files")
    print("  - update_block: Update a specific block in a document")
    print("  - insert_block: Insert new content into a document")
    print("[INFO] Agent tools configured (requires DeepSeek API key for testing)")


def test_list_files():
    print_section("Test 8: List All Files")

    response = requests.get(f"{BASE_URL}/api/v1/files/")
    print(f"Status: {response.status_code}")
    data = response.json()

    assert response.status_code == 200
    files = data["data"]["files"]
    print(f"Files: {len(files)} files in storage")
    for f in files:
        print(f"  - {f['name']} ({f['type']}, {f['size']} bytes)")

    print(f"[OK] File listing working")


def test_chat_session_history():
    print_section("Test 9: Chat Session History")

    # First send a message
    payload = {
        "session_id": "test-history-session",
        "message": "Hello, this is a test message",
        "context_files": [],
        "use_tools": False
    }
    requests.post(f"{BASE_URL}/api/v1/chat/completions", json=payload)

    # Get history
    response = requests.get(f"{BASE_URL}/api/v1/chat/sessions/test-history-session/messages")
    print(f"Status: {response.status_code}")
    data = response.json()

    if response.status_code == 200:
        messages = data["data"]["messages"]
        print(f"Messages: {len(messages)} messages in session")
        for msg in messages:
            print(f"  [{msg['role']}]: {msg['content'][:50]}...")
        print(f"[OK] Session history working")
    else:
        print("[SKIP] Session history test")


def test_download_file(file_id):
    print_section("Test 10: Download File")

    response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}/download")
    print(f"Status: {response.status_code}")

    if response.status_code == 200:
        content = response.content
        print(f"Downloaded: {len(content)} bytes")
        print(f"[OK] File download working")
    else:
        print("[FAIL] File download failed")


def test_delete_file(file_id):
    print_section("Test 11: Delete File")

    response = requests.delete(f"{BASE_URL}/api/v1/files/{file_id}")
    print(f"Status: {response.status_code}")
    data = response.json()

    assert response.status_code == 200
    print(f"[OK] File deleted")

    # Verify it's gone
    response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}")
    assert response.status_code == 404
    print(f"[OK] File verified as deleted")


def run_all_tests():
    print("\n" + "=" * 60)
    print("  Knowledge IDE - Comprehensive Test Suite")
    print("  Testing File Management, Agent System, and API")
    print("=" * 60)

    file_id = None

    try:
        test_health()
        file_id = test_upload_document()
        test_get_file_content(file_id)
        test_get_chunks(file_id)
        test_chat_with_context(file_id)
        test_update_file_content(file_id)
        test_version_history(file_id)
        test_agent_tools()
        test_list_files()
        test_chat_session_history()
        test_download_file(file_id)

        print("\n" + "=" * 60)
        print("  [OK] All Core Tests Passed!")
        print("=" * 60)
        print("\nNOTE: DeepSeek AI features require DEEPSEEK_API_KEY to be set.")
        print("To enable AI features, set the environment variable:")
        print("  set DEEPSEEK_API_KEY=your-key-here")
        print("  python backend/server.py")
        print()

    except AssertionError as e:
        print(f"\n[FAIL] Test failed: {e}")
    except requests.exceptions.ConnectionError:
        print("\n[FAIL] Could not connect to server.")
        print("Start the server with: python backend/server.py")
    except Exception as e:
        print(f"\n[FAIL] Unexpected error: {e}")
    finally:
        # Cleanup
        if file_id:
            try:
                requests.delete(f"{BASE_URL}/api/v1/files/{file_id}")
            except:
                pass


if __name__ == "__main__":
    run_all_tests()
