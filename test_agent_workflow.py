"""
Comprehensive test script for Agent Tool Workflow

Tests:
1. File upload (PDF and Markdown)
2. Session creation with permissions
3. Agent reading PDF documents
4. Agent editing markdown documents
5. Complete chat workflow with tool calls
"""

import asyncio
import httpx
import json
from pathlib import Path

BASE_URL = "http://localhost:8000/api/v1"

class AgentWorkflowTester:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=30.0)
        self.session_id = "test-session-" + str(hash("test") % 10000)
        self.test_files = {}

    async def cleanup(self):
        await self.client.aclose()

    async def test_1_upload_markdown(self):
        """Test 1: Upload a test markdown file"""
        print("\n=== Test 1: Upload Markdown File ===")

        content = """# Test Document

This is a test markdown document for agent editing.

## Section 1
Some initial content here.

## Section 2
- Item 1
- Item 2
"""

        try:
            response = await self.client.post(
                f"{BASE_URL}/files/upload",
                files={"file": ("test.md", content, "text/markdown")}
            )
            response.raise_for_status()
            data = response.json()

            if data.get("success"):
                self.test_files["md"] = data["data"]["file_id"]
                print(f"✓ Markdown uploaded: {data['data']['file_id']}")
                print(f"  Name: {data['data']['name']}")
                return True
            else:
                print(f"✗ Upload failed: {data.get('error')}")
                return False

        except Exception as e:
            print(f"✗ Error: {e}")
            return False

    async def test_2_upload_pdf(self):
        """Test 2: Upload or use existing PDF file"""
        print("\n=== Test 2: Check PDF File ===")

        try:
            # Try to get list of existing files
            response = await self.client.get(f"{BASE_URL}/files/")
            response.raise_for_status()
            data = response.json()

            if data.get("success"):
                files = data.get("data", {}).get("files", [])
                pdf_files = [f for f in files if f.get("type") == "pdf"]

                if pdf_files:
                    self.test_files["pdf"] = pdf_files[0]["id"]
                    print(f"✓ Found existing PDF: {pdf_files[0]['name']}")
                    print(f"  ID: {pdf_files[0]['id']}")
                    return True
                else:
                    print("⚠ No PDF files found. Please upload a PDF manually.")
                    return False
            else:
                print(f"✗ Failed to list files: {data.get('error')}")
                return False

        except Exception as e:
            print(f"✗ Error: {e}")
            return False

    async def test_3_create_session_with_permissions(self):
        """Test 3: Create session and set permissions"""
        print("\n=== Test 3: Set Session Permissions ===")

        try:
            # First, create session with an initial chat
            init_response = await self.client.post(
                f"{BASE_URL}/chat/completions",
                json={
                    "session_id": self.session_id,
                    "message": "Hello, I'm starting a new session."
                }
            )
            init_response.raise_for_status()
            print(f"✓ Session created via initial chat")

            # Set read permission for PDF
            if "pdf" in self.test_files:
                response = await self.client.post(
                    f"{BASE_URL}/chat/sessions/{self.session_id}/permissions",
                    params={
                        "file_id": self.test_files["pdf"],
                        "permission": "read"
                    }
                )
                response.raise_for_status()
                print(f"✓ PDF read permission granted")

            # Set write permission for markdown
            if "md" in self.test_files:
                response = await self.client.post(
                    f"{BASE_URL}/chat/sessions/{self.session_id}/permissions",
                    params={
                        "file_id": self.test_files["md"],
                        "permission": "write"
                    }
                )
                response.raise_for_status()
                print(f"✓ Markdown write permission granted")

            return True

        except Exception as e:
            print(f"✗ Error: {e}")
            return False

    async def test_4_agent_read_pdf(self):
        """Test 4: Agent reads PDF document"""
        print("\n=== Test 4: Agent Read PDF ===")

        if "pdf" not in self.test_files:
            print("⚠ Skipping - no PDF available")
            return False

        try:
            request_data = {
                "session_id": self.session_id,
                "message": f"Please use the read_document tool to read the PDF document with file_id '{self.test_files['pdf']}' and summarize its first page.",
                "context_files": [self.test_files["pdf"]]
            }

            response = await self.client.post(
                f"{BASE_URL}/chat/completions",
                json=request_data
            )
            response.raise_for_status()
            data = response.json()

            if data.get("success"):
                content = data["data"]["content"]
                tool_calls = data["data"].get("tool_calls")
                tool_results = data["data"].get("tool_results")

                print(f"✓ Agent responded successfully")
                print(f"  Response: {content[:200]}...")

                if tool_calls:
                    print(f"  Tool calls made: {len(tool_calls)}")
                    for tc in tool_calls:
                        print(f"    - {tc.get('function', {}).get('name', tc.get('name'))}")

                if tool_results:
                    print(f"  Tool results: {len(tool_results)}")
                    for tr in tool_results:
                        print(f"    - {tr.get('tool')}: {'✓' if tr.get('result', {}).get('success') else '✗'}")

                return True
            else:
                print(f"✗ Chat failed: {data.get('error')}")
                return False

        except Exception as e:
            print(f"✗ Error: {e}")
            return False

    async def test_5_agent_read_markdown(self):
        """Test 5: Agent reads markdown document"""
        print("\n=== Test 5: Agent Read Markdown ===")

        if "md" not in self.test_files:
            print("⚠ Skipping - no markdown available")
            return False

        try:
            request_data = {
                "session_id": self.session_id,
                "message": f"Please use the read_document tool to read the markdown file with file_id '{self.test_files['md']}' and tell me what sections it contains.",
                "context_files": [self.test_files["md"]]
            }

            response = await self.client.post(
                f"{BASE_URL}/chat/completions",
                json=request_data
            )
            response.raise_for_status()
            data = response.json()

            if data.get("success"):
                content = data["data"]["content"]
                print(f"✓ Agent read markdown successfully")
                print(f"  Response: {content[:200]}...")
                return True
            else:
                print(f"✗ Failed: {data.get('error')}")
                return False

        except Exception as e:
            print(f"✗ Error: {e}")
            return False

    async def test_6_agent_update_markdown(self):
        """Test 6: Agent updates markdown document"""
        print("\n=== Test 6: Agent Update Markdown ===")

        if "md" not in self.test_files:
            print("⚠ Skipping - no markdown available")
            return False

        try:
            request_data = {
                "session_id": self.session_id,
                "message": f"Please use the append_document tool to add a new section '## Section 3' with content 'This section was added by the AI agent.' to the markdown file with file_id '{self.test_files['md']}'.",
                "context_files": [self.test_files["md"]]
            }

            response = await self.client.post(
                f"{BASE_URL}/chat/completions",
                json=request_data
            )
            response.raise_for_status()
            data = response.json()

            if data.get("success"):
                content = data["data"]["content"]
                tool_results = data["data"].get("tool_results", [])

                print(f"✓ Agent responded")
                print(f"  Response: {content[:200]}...")

                # Check if update tool was called
                update_tool_used = any(
                    tr.get("tool") in ["update_document", "append_document"]
                    for tr in tool_results
                )

                if update_tool_used:
                    print(f"  ✓ Document modification tool was called")
                    for tr in tool_results:
                        if tr.get("tool") in ["update_document", "append_document"]:
                            result = tr.get("result", {})
                            if result.get("success"):
                                print(f"    ✓ {tr['tool']}: Success")
                                if "version_id" in result.get("data", {}):
                                    print(f"      Version: {result['data']['version_id']}")
                            else:
                                print(f"    ✗ {tr['tool']}: {result.get('error')}")
                    return True
                else:
                    print(f"  ⚠ No modification tool was called")
                    return False
            else:
                print(f"✗ Failed: {data.get('error')}")
                return False

        except Exception as e:
            print(f"✗ Error: {e}")
            return False

    async def test_7_verify_markdown_changes(self):
        """Test 7: Verify markdown was actually changed"""
        print("\n=== Test 7: Verify Markdown Changes ===")

        if "md" not in self.test_files:
            print("⚠ Skipping - no markdown available")
            return False

        try:
            response = await self.client.get(
                f"{BASE_URL}/files/{self.test_files['md']}/content"
            )
            response.raise_for_status()
            data = response.json()

            if data.get("success"):
                content = data["data"]["content"]

                # Check if Section 3 was added
                if "## Section 3" in content:
                    print(f"✓ Markdown file was successfully modified")
                    print(f"  Content preview:")
                    print("  " + "\n  ".join(content.split("\n")[:15]))
                    return True
                else:
                    print(f"✗ Section 3 not found in modified file")
                    print(f"  Current content:")
                    print("  " + "\n  ".join(content.split("\n")[:10]))
                    return False
            else:
                print(f"✗ Failed to get content: {data.get('error')}")
                return False

        except Exception as e:
            print(f"✗ Error: {e}")
            return False

    async def test_8_check_version_history(self):
        """Test 8: Check version history for changes"""
        print("\n=== Test 8: Check Version History ===")

        if "md" not in self.test_files:
            print("⚠ Skipping - no markdown available")
            return False

        try:
            response = await self.client.get(
                f"{BASE_URL}/files/{self.test_files['md']}/versions"
            )
            response.raise_for_status()
            data = response.json()

            if data.get("success"):
                versions = data["data"].get("versions", [])
                print(f"✓ Found {len(versions)} versions")

                for i, ver in enumerate(versions[:3]):
                    print(f"  Version {i+1}:")
                    print(f"    Author: {ver.get('author')}")
                    print(f"    Type: {ver.get('change_type')}")
                    print(f"    Summary: {ver.get('summary')}")
                    print(f"    Timestamp: {ver.get('timestamp')}")

                return len(versions) > 0
            else:
                print(f"⚠ No version history endpoint available")
                return False

        except Exception as e:
            print(f"⚠ Version history check skipped: {e}")
            return False

    async def run_all_tests(self):
        """Run all tests in sequence"""
        print("=" * 60)
        print("Agent Workflow Comprehensive Test Suite")
        print("=" * 60)
        print(f"Session ID: {self.session_id}")
        print(f"Backend URL: {BASE_URL}")

        results = {}

        # Run tests
        results["upload_markdown"] = await self.test_1_upload_markdown()
        results["check_pdf"] = await self.test_2_upload_pdf()
        results["set_permissions"] = await self.test_3_create_session_with_permissions()
        results["read_pdf"] = await self.test_4_agent_read_pdf()
        results["read_markdown"] = await self.test_5_agent_read_markdown()
        results["update_markdown"] = await self.test_6_agent_update_markdown()
        results["verify_changes"] = await self.test_7_verify_markdown_changes()
        results["version_history"] = await self.test_8_check_version_history()

        # Summary
        print("\n" + "=" * 60)
        print("Test Summary")
        print("=" * 60)

        for test_name, passed in results.items():
            status = "✓ PASS" if passed else "✗ FAIL"
            print(f"{status:8} | {test_name}")

        total = len(results)
        passed = sum(1 for v in results.values() if v)

        print("=" * 60)
        print(f"Total: {passed}/{total} tests passed ({passed*100//total}%)")
        print("=" * 60)

        await self.cleanup()


async def main():
    tester = AgentWorkflowTester()
    await tester.run_all_tests()


if __name__ == "__main__":
    asyncio.run(main())
