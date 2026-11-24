# DataNest

DataNest is a private, account-scoped universal data vault for files, notes and structured JSON records.

This repository contains the source snapshot exported from the AppDeploy application. See the application source and tests for the implemented behaviour and current limits.

## Current implementation

- Authenticated, per-account records and file paths
- Notes and validated JSON records
- Chunked file upload and original-file download
- Search, folders, tags and ZIP export
- React, TypeScript and Vite frontend; AppDeploy SDK backend

## Important limits

The current app is not unlimited cloud storage and does not yet implement Google Drive, OneDrive, Dropbox or a federated storage pool. The backend enforces a 50 MiB maximum file size and 180 KiB maximum note/JSON record content. Provider quotas and integrations must be implemented and verified separately before advertising pooled capacity.
