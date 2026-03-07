from __future__ import annotations

import ast
import sys
import warnings
from typing import Any, Dict, List, Optional

from app.config import settings
from app.models import DocumentChunk

if sys.version_info >= (3, 14):
    chromadb = None
    ChromaSettings = None
    _CHROMA_IMPORT_ERROR = RuntimeError("ChromaDB is disabled on Python 3.14+ due pydantic.v1 incompatibility.")
else:
    try:
        import chromadb
        from chromadb.config import Settings as ChromaSettings
    except Exception as exc:  # pragma: no cover - defensive import guard
        chromadb = None
        ChromaSettings = None
        _CHROMA_IMPORT_ERROR = exc
    else:
        _CHROMA_IMPORT_ERROR = None


class VectorStore:
    """Vector database for semantic search using ChromaDB (best-effort fallback)."""

    def __init__(self):
        self.client = None
        self._collection = None
        self._segment_collection = None
        self.enabled = False

        if chromadb is None or ChromaSettings is None:
            warnings.warn(
                f"ChromaDB unavailable, semantic vector index disabled: {_CHROMA_IMPORT_ERROR}",
                RuntimeWarning,
            )
            return

        try:
            self.client = chromadb.PersistentClient(
                path=settings.CHROMA_PERSIST_DIR,
                settings=ChromaSettings(
                    anonymized_telemetry=False,
                    allow_reset=True,
                ),
            )
            self.enabled = True
        except Exception as exc:  # pragma: no cover - runtime env specific
            warnings.warn(
                f"Failed to initialize ChromaDB client, semantic vector index disabled: {exc}",
                RuntimeWarning,
            )

    @staticmethod
    def _documents_collection_metadata() -> Dict[str, Any]:
        return {"hnsw:space": "cosine"}

    @staticmethod
    def _segment_collection_metadata() -> Dict[str, Any]:
        return {
            "hnsw:space": "cosine",
            "embedding_model": str(settings.EMBEDDING_MODEL or ""),
            "embedding_dimensions": int(settings.EMBEDDING_DIMENSIONS or 0),
        }

    @staticmethod
    def _is_dimension_mismatch_error(exc: Exception) -> bool:
        message = str(exc or "").lower()
        return "dimension" in message and (
            "collection dimensionality" in message
            or "dimensionality" in message
            or "dimensions" in message
        )

    def _get_or_create_collection(
        self,
        *,
        attr_name: str,
        name: str,
        metadata: Dict[str, Any],
    ):
        collection = getattr(self, attr_name)
        if collection is None:
            collection = self.client.get_or_create_collection(name=name, metadata=metadata)
            setattr(self, attr_name, collection)
        return collection

    def _reset_collection(
        self,
        *,
        attr_name: str,
        name: str,
        metadata: Dict[str, Any],
    ):
        if not self.enabled or self.client is None:
            raise RuntimeError("ChromaDB vector index is disabled")
        try:
            self.client.delete_collection(name=name)
        except TypeError:
            self.client.delete_collection(name)
        except Exception:
            pass
        collection = self.client.get_or_create_collection(name=name, metadata=metadata)
        setattr(self, attr_name, collection)
        return collection

    def _run_collection_operation(
        self,
        *,
        attr_name: str,
        name: str,
        metadata: Dict[str, Any],
        operation,
    ):
        collection = self._get_or_create_collection(attr_name=attr_name, name=name, metadata=metadata)
        try:
            return operation(collection)
        except Exception as exc:
            if not self._is_dimension_mismatch_error(exc):
                raise
            warnings.warn(
                f"Resetting ChromaDB collection '{name}' due embedding dimension mismatch: {exc}",
                RuntimeWarning,
            )
            collection = self._reset_collection(attr_name=attr_name, name=name, metadata=metadata)
            return operation(collection)

    @property
    def collection(self):
        if not self.enabled or self.client is None:
            raise RuntimeError("ChromaDB vector index is disabled")
        return self._get_or_create_collection(
            attr_name="_collection",
            name="documents",
            metadata=self._documents_collection_metadata(),
        )

    @property
    def segment_collection(self):
        if not self.enabled or self.client is None:
            raise RuntimeError("ChromaDB vector index is disabled")
        return self._get_or_create_collection(
            attr_name="_segment_collection",
            name="segment_embeddings",
            metadata=self._segment_collection_metadata(),
        )

    async def add_chunks(self, chunks: List[DocumentChunk], embeddings: List[List[float]]):
        """Add document chunks with their embeddings to the vector store."""
        if not self.enabled or not chunks:
            return

        ids = [chunk.id for chunk in chunks]
        documents = [chunk.content for chunk in chunks]
        metadatas = [
            self._sanitize_metadata(
                {
                    "file_id": chunk.file_id,
                    "page": chunk.page,
                    "chunk_index": chunk.chunk_index,
                    "bbox": str(chunk.bbox) if chunk.bbox else None,
                }
            )
            for chunk in chunks
        ]

        self._run_collection_operation(
            attr_name="_collection",
            name="documents",
            metadata=self._documents_collection_metadata(),
            operation=lambda collection: collection.add(
                ids=ids,
                embeddings=embeddings,
                documents=documents,
                metadatas=metadatas,
            ),
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
        if not self.enabled:
            return {"ids": [[]], "documents": [[]], "metadatas": [[]], "distances": [[]]}

        where = {}
        if file_id:
            where["file_id"] = file_id
        if page is not None:
            where["page"] = page

        results = self._run_collection_operation(
            attr_name="_collection",
            name="documents",
            metadata=self._documents_collection_metadata(),
            operation=lambda collection: collection.query(
                query_embeddings=[query_embedding],
                n_results=n_results,
                where=where if where else None,
            ),
        )

        return results

    async def delete_by_file(self, file_id: str):
        """Delete all chunks associated with a file."""
        if not self.enabled:
            return

        # ChromaDB doesn't support filtering in delete directly
        # We need to get the ids first
        results = self.collection.get(
            where={"file_id": file_id}
        )
        if results and results["ids"]:
            self.collection.delete(ids=results["ids"])

    async def add_segment_embeddings(
        self,
        *,
        ids: List[str],
        embeddings: List[List[float]],
        documents: List[str],
        metadatas: List[Dict[str, Any]],
    ):
        """Add segment embeddings (text/image/fused) for multimodal retrieval."""
        if not self.enabled or not ids:
            return
        self._run_collection_operation(
            attr_name="_segment_collection",
            name="segment_embeddings",
            metadata=self._segment_collection_metadata(),
            operation=lambda collection: collection.add(
                ids=ids,
                embeddings=embeddings,
                documents=documents,
                metadatas=[self._sanitize_metadata(metadata) for metadata in metadatas],
            ),
        )

    @staticmethod
    def _sanitize_metadata(metadata: Dict[str, Any]) -> Dict[str, Any]:
        clean: Dict[str, Any] = {}
        for key, value in (metadata or {}).items():
            if value is None:
                continue
            if isinstance(value, (str, int, float, bool)):
                clean[key] = value
                continue
            clean[key] = str(value)
        return clean

    def _compose_where(
        self,
        *,
        file_ids: Optional[List[str]] = None,
        modalities: Optional[List[str]] = None,
        source_types: Optional[List[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        clauses: List[Dict[str, Any]] = []
        if file_ids:
            if len(file_ids) == 1:
                clauses.append({"file_id": file_ids[0]})
            else:
                clauses.append({"file_id": {"$in": file_ids}})
        if modalities:
            if len(modalities) == 1:
                clauses.append({"modality": modalities[0]})
            else:
                clauses.append({"modality": {"$in": modalities}})
        if source_types:
            if len(source_types) == 1:
                clauses.append({"source_type": source_types[0]})
            else:
                clauses.append({"source_type": {"$in": source_types}})

        if not clauses:
            return None
        if len(clauses) == 1:
            return clauses[0]
        return {"$and": clauses}

    async def search_segment_embeddings(
        self,
        *,
        query_embedding: List[float],
        n_results: int = 10,
        file_ids: Optional[List[str]] = None,
        modalities: Optional[List[str]] = None,
        source_types: Optional[List[str]] = None,
    ) -> dict:
        """Search segment embedding collection with optional metadata filters."""
        if not self.enabled:
            return {"ids": [[]], "documents": [[]], "metadatas": [[]], "distances": [[]]}

        where = self._compose_where(
            file_ids=file_ids,
            modalities=modalities,
            source_types=source_types,
        )
        return self._run_collection_operation(
            attr_name="_segment_collection",
            name="segment_embeddings",
            metadata=self._segment_collection_metadata(),
            operation=lambda collection: collection.query(
                query_embeddings=[query_embedding],
                n_results=n_results,
                where=where,
            ),
        )

    async def delete_segment_embeddings_by_file(self, file_id: str):
        if not self.enabled:
            return
        results = self.segment_collection.get(where={"file_id": file_id})
        if results and results.get("ids"):
            self.segment_collection.delete(ids=results["ids"])

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
        if not self.enabled:
            return []

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
                chunk_bbox = ast.literal_eval(chunk_bbox) if isinstance(chunk_bbox, str) else chunk_bbox
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
        if self.enabled and self.client is not None:
            self.client.reset()
            self._collection = None
            self._segment_collection = None


vector_store = VectorStore()
