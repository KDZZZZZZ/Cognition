import chromadb
from chromadb.config import Settings as ChromaSettings
from typing import List, Optional
import uuid

from app.config import settings
from app.models import DocumentChunk


class VectorStore:
    """Vector database for semantic search using ChromaDB."""

    def __init__(self):
        self.client = chromadb.PersistentClient(
            path=settings.CHROMA_PERSIST_DIR,
            settings=ChromaSettings(
                anonymized_telemetry=False,
                allow_reset=True
            )
        )
        self._collection = None

    @property
    def collection(self):
        if self._collection is None:
            self._collection = self.client.get_or_create_collection(
                name="documents",
                metadata={"hnsw:space": "cosine"}
            )
        return self._collection

    async def add_chunks(self, chunks: List[DocumentChunk], embeddings: List[List[float]]):
        """Add document chunks with their embeddings to the vector store."""
        if not chunks:
            return

        ids = [chunk.id for chunk in chunks]
        documents = [chunk.content for chunk in chunks]
        metadatas = [
            {
                "file_id": chunk.file_id,
                "page": chunk.page,
                "chunk_index": chunk.chunk_index,
                "bbox": str(chunk.bbox) if chunk.bbox else None
            }
            for chunk in chunks
        ]

        self.collection.add(
            ids=ids,
            embeddings=embeddings,
            documents=documents,
            metadatas=metadatas
        )

    async def search(
        self,
        query_embedding: List[float],
        n_results: int = 10,
        file_id: Optional[str] = None,
        page: Optional[int] = None
    ) -> dict:
        """
        Search for similar chunks.

        Returns:
            Dictionary with ids, distances, metadatas, and documents
        """
        where = {}
        if file_id:
            where["file_id"] = file_id
        if page is not None:
            where["page"] = page

        results = self.collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results,
            where=where if where else None
        )

        return results

    async def delete_by_file(self, file_id: str):
        """Delete all chunks associated with a file."""
        # ChromaDB doesn't support filtering in delete directly
        # We need to get the ids first
        results = self.collection.get(
            where={"file_id": file_id}
        )
        if results and results["ids"]:
            self.collection.delete(ids=results["ids"])

    async def get_chunks_in_bbox(
        self,
        file_id: str,
        page: int,
        bbox: tuple[float, float, float, float],
        threshold: float = 0.5
    ) -> List[str]:
        """
        Get chunks that intersect with a given bounding box.

        Args:
            file_id: The file to search in
            page: The page number
            bbox: (x0, y0, x1, y1) bounding box
            threshold: Overlap threshold (0-1)

        Returns:
            List of chunk contents
        """
        results = self.collection.get(
            where={"file_id": file_id, "page": page}
        )

        if not results or not results["metadatas"]:
            return []

        matching_chunks = []
        x0, y0, x1, y1 = bbox

        for i, metadata in enumerate(results["metadatas"]):
            chunk_bbox = metadata.get("bbox")
            if not chunk_bbox:
                continue

            # Parse bbox from string format
            try:
                chunk_bbox = eval(chunk_bbox) if isinstance(chunk_bbox, str) else chunk_bbox
                cx0, cy0, cx1, cy1 = chunk_bbox

                # Calculate overlap
                overlap_x = max(0, min(x1, cx1) - max(x0, cx0))
                overlap_y = max(0, min(y1, cy1) - max(y0, cy0))
                overlap_area = overlap_x * overlap_y

                bbox_area = (x1 - x0) * (y1 - y0)
                if bbox_area > 0 and overlap_area / bbox_area >= threshold:
                    matching_chunks.append(results["documents"][i])
            except:
                pass

        return matching_chunks

    def reset(self):
        """Clear all data from the vector store."""
        self.client.reset()


vector_store = VectorStore()
