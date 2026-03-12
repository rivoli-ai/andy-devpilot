Backend TLS certificates
========================

This folder is optional and is only needed if you're behind a corporate
proxy / SSL inspection solution (Zscaler, BlueCoat, etc.).

Any `.crt` / `.pem` files you place here will be copied into the backend
build container and added to its trusted certificate store, so that
`dotnet restore` / `dotnet publish` can talk to:

- `https://api.nuget.org/`
- `https://nuget.org/`
- and any internal NuGet feeds secured by your company CA.

Usage
-----

- Export your corporate root / intermediate CAs as `.crt` or `.pem`.
- Drop them into this folder.
- Rebuild the backend image, for example:

  ```bash
  docker compose build devpilot-backend
  ```

You can reuse the same certificates you put in `infra/sandbox/certs/`;
just copy them here or create a symlink on your workstation.

