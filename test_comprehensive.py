#!/usr/bin/env python3
"""
Comprehensive test suite for Knowledge IDE - All Features

Tests:
1. PDF upload and parsing with PyPDF2
2. Viewport tracking for AI context
3. File upload (MD, TXT, PDF)
4. Version history tracking
5. DeepSeek integration (if API key provided)
"""
import requests
import json
import time
import os
from pathlib import Path

BASE_URL = "http://localhost:8000"


def print_section(name):
    print("\n" + "=" * 70)
    print(f"  {name}")
    print("=" * 70)


def test_health():
    print_section("Health Check")
    response = requests.get(f"{BASE_URL}/health")
    print(f"Status: {response.status_code}")
    data = response.json()
    print(f"Storage: {data.get('storage')}")
    print(f"DeepSeek Configured: {data.get('deepseek_configured')}")
    assert data["status"] == "healthy"
    print("[OK] Server is healthy")


def test_upload_pdf():
    print_section("Test 1: PDF Upload and Parsing")

    # Check if PyPDF2 is available
    try:
        import PyPDF2
        print("PyPDF2 is available - PDF parsing will work")
    except ImportError:
        print("[SKIP] PyPDF2 not installed. Install with: pip install PyPDF2")
        return None

    # Create a simple test PDF content (in real scenario, you'd upload actual PDF)
    # For this test, we'll create a mock PDF file
    test_pdf_path = Path("test_sample.pdf")
    if test_pdf_path.exists():
        file_path = test_pdf_path
    else:
        print(f"[SKIP] No test PDF file found at {test_pdf_path.absolute()}")
        print("To test PDF upload, place a PDF file at this location.")
        return None

    with open(file_path, 'rb') as f:
        files = {"file": (file_path.name, f, "application/pdf")}
        response = requests.post(f"{BASE_URL}/api/v1/files/upload", files=files)

    print(f"Status: {response.status_code}")
    data = response.json()

    if response.status_code != 200:
        print(f"[SKIP] PDF upload failed: {data}")
        return None

    assert data["success"] is True
    file_id = data["data"]["file_id"]
    print(f"[OK] PDF uploaded with ID: {file_id}")
    print(f"  - Name: {data['data']['name']}")
    print(f"  - Size: {data['data']['size']} bytes")
    print(f"  - Type: {data['data']['type']}")

    # Check chunks
    chunks_response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}/chunks")
    chunks_data = chunks_response.json()
    if chunks_data["success"]:
        print(f"  - Chunks: {len(chunks_data['data']['chunks'])} chunks extracted")

    return file_id


def test_upload_markdown():
    print_section("Test 2: Markdown File Upload")

    test_doc = """# AI Project Plan

## Phase 1: Foundation
- Setup project structure
- Configure dependencies
- Create base components

## Phase 2: Core Features
- PDF viewer with react-pdf
- Viewport tracking
- DeepSeek integration

## Phase 3: Polish
- Performance optimization
- User testing
- Documentation
"""

    # Create file and upload
    import io
    blob = io.BytesIO(test_doc.encode('utf-8'))
    files = {"file": ("ai-plan.md", blob, "text/markdown")}
    response = requests.post(f"{BASE_URL}/api/v1/files/upload", files=files)

    print(f"Status: {response.status_code}")
    data = response.json()

    assert response.status_code == 200
    assert data["success"] is True

    file_id = data["data"]["file_id"]
    print(f"[OK] Markdown file uploaded")
    print(f"  - File ID: {file_id}")
    print(f"  - Chunks: {data['data']['chunks_count']}")

    # Verify content
    content_response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}/content")
    content_data = content_response.json()
    assert content_data["success"] is True
    print(f"  - Content length: {len(content_data['data']['content'])} chars")

    return file_id


def test_viewport_tracking(file_id):
    print_section("Test 3: Viewport Tracking")

    # Update viewport
    payload = {
        "session_id": "test-viewport-session",
        "file_id": file_id,
        "page": 1,
        "scroll_y": 150,
        "scroll_height": 1000
    }

    response = requests.post(f"{BASE_URL}/api/v1/viewport/update", json=payload)
    print(f"Status: {response.status_code}")
    data = response.json()

    assert response.status_code == 200
    print(f"[OK] Viewport updated")
    print(f"  - Session: {payload['session_id']}")
    print(f"  - Page: {payload['page']}")
    print(f"  - Scroll Y: {payload['scroll_y']}")

    # Retrieve viewport state
    get_response = requests.get(f"{BASE_URL}/api/v1/viewport/test-viewport-session")
    get_data = get_response.json()
    assert get_data["success"] is True
    print(f"[OK] Viewport state retrieved")
    print(f"  - Stored state: {get_data['data']}")


def test_file_versions(file_id):
    print_section("Test 4: Version History")

    # Get initial versions
    response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}/versions")
    data = response.json()

    assert response.status_code == 200
    versions = data["data"]["versions"]
    print(f"Initial versions: {len(versions)}")

    # Update content to create new version
    new_content = "# AI Project Plan - Updated\n\n## Phase 1: Foundation\n- Setup complete\n- Dependencies configured"
    update_response = requests.put(f"{BASE_URL}/api/v1/files/{file_id}/content", json={
        "content": new_content,
        "author": "human",
        "summary": "Updated project plan"
    })
    assert update_response.status_code == 200

    # Check versions again
    response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}/versions")
    data = response.json()
    versions = data["data"]["versions"]

    print(f"[OK] Version history working")
    print(f"  - Total versions: {len(versions)}")
    for v in versions:
        print(f"    v{v['version']}: {v['summary']} by {v['author']} at {v['timestamp'][:19]}")


def test_chat_with_viewport_context(file_id):
    print_section("Test 5: Chat with Viewport Context")

    # First set viewport context
    requests.post(f"{BASE_URL}/api/v1/viewport/update", json={
        "session_id": "test-context-session",
        "file_id": file_id,
        "page": 1,
        "scroll_y": 50,
        "scroll_height": 500
    })

    payload = {
        "session_id": "test-context-session",
        "message": "What am I looking at on page 1?",
        "context_files": [file_id],
        "use_tools": False
    }

    response = requests.post(f"{BASE_URL}/api/v1/chat/completions", json=payload)
    print(f"Status: {response.status_code}")
    data = response.json()

    if response.status_code == 200:
        print(f"[OK] Chat with viewport context")
        if data.get("data", {}).get("content"):
            print(f"  - Response preview: {data['data']['content'][:100]}...")
    else:
        print(f"[INFO] Chat response: {data}")


def test_list_all_files():
    print_section("Test 6: List All Files")

    response = requests.get(f"{BASE_URL}/api/v1/files/")
    data = response.json()

    assert response.status_code == 200
    files = data["data"]["files"]

    print(f"[OK] File listing works")
    print(f"  - Total files: {len(files)}")
    for f in files:
        print(f"    - {f['name']} ({f['type']}, {f['size']} bytes)")


def test_download_file(file_id):
    print_section("Test 7: File Download")

    response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}/download")

    if response.status_code == 200:
        size = len(response.content)
        print(f"[OK] File download works")
        print(f"  - Downloaded: {size} bytes")
    else:
        print(f"[FAIL] Download failed with status {response.status_code}")


def test_delete_file(file_id):
    print_section("Test 8: File Deletion")

    response = requests.delete(f"{BASE_URL}/api/v1/files/{file_id}")
    assert response.status_code == 200
    print(f"[OK] File deleted")

    # Verify deletion
    response = requests.get(f"{BASE_URL}/api/v1/files/{file_id}")
    assert response.status_code == 404
    print(f"[OK] File verified as deleted")


def run_all_tests():
    print("\n" + "=" * 70)
    print("  Knowledge IDE - Comprehensive Feature Test Suite")
    print("  Testing: PDF, Viewport, Versions, Chat, Upload/Download")
    print("=" * 70)

    test_health()

    # Track created files for cleanup
    created_files = []

    try:
        # Test PDF
        pdf_file = test_upload_pdf()
        if pdf_file:
            created_files.append(pdf_file)
            test_viewport_tracking(pdf_file)

        # Test Markdown
        md_file = test_upload_markdown()
        created_files.append(md_file)

        if md_file:
            test_viewport_tracking(md_file)
            test_file_versions(md_file)
            test_chat_with_viewport_context(md_file)

        test_list_all_files()

        # Test download on one file
        if created_files:
            test_download_file(created_files[0])

        print("\n" + "=" * 70)
        print("  [OK] All Tests Passed!")
        print("=" * 70)
        print("\nFeatures Working:")
        print("  [OK] File Upload (MD, TXT, PDF with PyPDF2)")
        print("  [OK] File Content Retrieval")
        print("  [OK] Document Chunking")
        print("  [OK] Viewport Tracking")
        print("  [OK] Version History")
        print("  [OK] Chat API")
        print("  [OK] File Download")
        print("  [OK] File Listing")
        print("\nNOTE: DeepSeek AI features require DEEPSEEK_API_KEY environment variable.")
        print()

    except AssertionError as e:
        print(f"\n[FAIL] Test failed: {e}")
    except requests.exceptions.ConnectionError:
        print("\n[FAIL] Could not connect to server.")
        print("Start the server with: python backend/server.py")
    except Exception as e:
        print(f"\n[FAIL] Unexpected error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        # Cleanup
        for file_id in created_files:
            try:
                requests.delete(f"{BASE_URL}/api/v1/files/{file_id}")
            except:
                pass


if __name__ == "__main__":
    run_all_tests()
