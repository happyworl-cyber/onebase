# Kafka Admin Create Topic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let project members create Kafka topics from the OneBase Kafka Topics tab via JWT admin API.

**Architecture:** Validate name/partitions/RF in `kafka_ds::commands::create_topic`, call rdkafka `AdminClient::create_topics`, expose `POST /api/admin/kafka-connections/:id/topics`, add TopicsTab form + `kafkaAPI.createTopic`. No token REST or workflow changes.

**Tech Stack:** Rust/Axum, rdkafka AdminClient, Next.js Kafka connections page.

## Global Constraints

- JWT admin only; do not add `create_topic` to token ops or workflow `SUPPORTED_OPS`
- Params: `name`, `num_partitions` (1..=100), `replication_factor` (1..=10)
- Auth same as `list_topics` (`fetch_connection_authorized` + active connection)
- TopicAlreadyExists → 400「topic 已存在」

---

## Task 1: Command layer + unit tests

**Files:** `src/kafka_ds/commands.rs`

- [x] Add `validate_new_topic` + `create_topic`
- [x] Unit tests for validation edges
- [x] `cargo test kafka_ds::commands` passes

## Task 2: Handler + route

**Files:** `src/kafka_handlers.rs`, `src/main.rs`

- [x] `CreateTopicReq` + `create_topic` handler
- [x] Route: same path as list, add `.post(...)`
- [x] `cargo check` passes

## Task 3: Frontend

**Files:** `frontend-nextjs/lib/api.ts`, `frontend-nextjs/app/workspace/[projectId]/events/kafka-connections/page.tsx`

- [x] `kafkaAPI.createTopic`
- [x] TopicsTab「新建 Topic」form (defaults 1/1)
- [x] Success → reload list; show errors
