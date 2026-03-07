from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.models import DocumentChunk
from app.services.vector_store import VectorStore


class FakeCollection:
    def __init__(self):
        self.add_calls = []
        self.query_calls = []
        self.get_calls = []
        self.delete_calls = []
        self._get_result = {"ids": []}
        self._query_result = {"ids": [[]], "documents": [[]], "metadatas": [[]], "distances": [[]]}

    def add(self, **kwargs):
        self.add_calls.append(kwargs)

    def query(self, **kwargs):
        self.query_calls.append(kwargs)
        return self._query_result

    def get(self, **kwargs):
        self.get_calls.append(kwargs)
        return self._get_result

    def delete(self, **kwargs):
        self.delete_calls.append(kwargs)


class DimensionMismatchCollection(FakeCollection):
    def add(self, **kwargs):
        raise ValueError("Embedding dimension 1024 does not match collection dimensionality 2048")


def _make_store(enabled: bool = True):
    store = VectorStore.__new__(VectorStore)
    store.client = object() if enabled else None
    store._collection = None
    store._segment_collection = None
    store.enabled = enabled
    return store


@pytest.mark.asyncio
async def test_vector_store_disabled_short_circuits():
    store = _make_store(enabled=False)
    assert await store.search([0.1]) == {"ids": [[]], "documents": [[]], "metadatas": [[]], "distances": [[]]}
    assert await store.search_segment_embeddings(query_embedding=[0.2]) == {
        "ids": [[]],
        "documents": [[]],
        "metadatas": [[]],
        "distances": [[]],
    }
    assert await store.get_chunks_in_bbox("f", 1, (0, 0, 10, 10)) == []


def test_collection_properties_and_compose_where():
    store = _make_store(enabled=True)
    docs = FakeCollection()
    segs = FakeCollection()
    store.client = SimpleNamespace(
        get_or_create_collection=lambda name, metadata: docs if name == "documents" else segs
    )

    assert store.collection is docs
    assert store.segment_collection is segs
    assert store._compose_where() is None
    assert store._compose_where(file_ids=["f1"]) == {"file_id": "f1"}
    assert store._compose_where(file_ids=["f1", "f2"], modalities=["text"]) == {
        "$and": [{"file_id": {"$in": ["f1", "f2"]}}, {"modality": "text"}]
    }


@pytest.mark.asyncio
async def test_add_search_and_delete_chunks():
    store = _make_store(enabled=True)
    collection = FakeCollection()
    collection._get_result = {"ids": ["c1", "c2"]}
    collection._query_result = {"ids": [["c1"]], "documents": [["doc"]], "metadatas": [[{"file_id": "f1"}]], "distances": [[0.1]]}
    store._collection = collection

    chunks = [
        DocumentChunk(id="c1", file_id="f1", page=1, chunk_index=0, content="alpha", bbox=(0, 0, 10, 10)),
        DocumentChunk(id="c2", file_id="f1", page=1, chunk_index=1, content="beta", bbox=None),
    ]
    await store.add_chunks(chunks, [[0.1], [0.2]])
    assert collection.add_calls[0]["ids"] == ["c1", "c2"]
    assert collection.add_calls[0]["metadatas"][1] == {"file_id": "f1", "page": 1, "chunk_index": 1}

    result = await store.search([0.3], n_results=5, file_id="f1", page=1)
    assert result["ids"][0] == ["c1"]
    assert collection.query_calls[0]["where"] == {"file_id": "f1", "page": 1}

    await store.delete_by_file("f1")
    assert collection.delete_calls[0]["ids"] == ["c1", "c2"]


@pytest.mark.asyncio
async def test_segment_embedding_paths():
    store = _make_store(enabled=True)
    segments = FakeCollection()
    segments._get_result = {"ids": ["s1"]}
    segments._query_result = {"ids": [["s1"]], "documents": [["seg"]], "metadatas": [[{"segment_id": "s1"}]], "distances": [[0.2]]}
    store._segment_collection = segments

    await store.add_segment_embeddings(
        ids=["s1"],
        embeddings=[[0.1, 0.2]],
        documents=["seg text"],
        metadatas=[{"file_id": "f1", "modality": "text", "page": None, "flags": ["a", "b"]}],
    )
    assert segments.add_calls[0]["ids"] == ["s1"]
    assert segments.add_calls[0]["metadatas"][0] == {"file_id": "f1", "modality": "text", "flags": "['a', 'b']"}

    result = await store.search_segment_embeddings(
        query_embedding=[0.8],
        file_ids=["f1"],
        modalities=["text"],
        source_types=["pdf"],
    )
    assert result["ids"][0] == ["s1"]
    assert "$and" in segments.query_calls[0]["where"]

    await store.delete_segment_embeddings_by_file("f1")
    assert segments.delete_calls[0]["ids"] == ["s1"]


@pytest.mark.asyncio
async def test_segment_embedding_dimension_mismatch_resets_collection():
    store = _make_store(enabled=True)
    stale = DimensionMismatchCollection()
    fresh = FakeCollection()
    deleted = []
    store._segment_collection = stale
    store.client = SimpleNamespace(
        delete_collection=lambda name=None: deleted.append(name),
        get_or_create_collection=lambda name, metadata: fresh,
    )

    await store.add_segment_embeddings(
        ids=["s1"],
        embeddings=[[0.1, 0.2]],
        documents=["seg text"],
        metadatas=[{"file_id": "f1", "modality": "text"}],
    )

    assert deleted == ["segment_embeddings"]
    assert store._segment_collection is fresh
    assert fresh.add_calls[0]["ids"] == ["s1"]


@pytest.mark.asyncio
async def test_get_chunks_in_bbox_and_reset():
    store = _make_store(enabled=True)
    collection = FakeCollection()
    collection._get_result = {
        "metadatas": [{"bbox": "(0, 0, 50, 50)"}, {"bbox": (100, 100, 120, 120)}, {"bbox": "bad"}],
        "documents": ["match-a", "miss-b", "bad-c"],
        "ids": ["1", "2", "3"],
    }
    store._collection = collection
    store.client = SimpleNamespace(reset=lambda: None)

    matched = await store.get_chunks_in_bbox("f1", 1, (10, 10, 40, 40), threshold=0.1)
    assert matched == ["match-a"]

    store.reset()  # no exception


def test_collection_raises_when_disabled():
    store = _make_store(enabled=False)
    with pytest.raises(RuntimeError):
        _ = store.collection


def test_sanitize_metadata_drops_none_and_stringifies_complex_values():
    assert VectorStore._sanitize_metadata(
        {"file_id": "f1", "page": None, "score": 0.5, "meta": {"a": 1}, "active": True}
    ) == {
        "file_id": "f1",
        "score": 0.5,
        "meta": "{'a': 1}",
        "active": True,
    }
