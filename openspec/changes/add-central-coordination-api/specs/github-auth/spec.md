# GitHub Auth

## ADDED Requirements

### Requirement: User login MUST be GitHub-backed and MUST verify allowed org membership before server session minting
This requirement applies to both pull requests and issues because the same user session governs all API access.

The system MUST authenticate human users through GitHub App user authorization and MUST verify membership in an allowed organization before issuing a server access token.

#### Scenario: Org member receives a server session
- **Given** a user completes GitHub authorization successfully
- **And** the user is an active member of an allowed organization
- **When** the server completes login
- **Then** it mints a server access token and refresh token
- **And** it records the user as authorized for API access

#### Scenario: Non-member is denied
- **Given** a user completes GitHub authorization successfully
- **And** the user is not an active member of an allowed organization
- **When** the server evaluates membership
- **Then** it denies the login
- **And** it does not mint a server session

### Requirement: CLI and TUI login MUST use a server-brokered device-flow path
This requirement applies to both pull requests and issues because the same session powers all item access.

The system MUST let headless clients authenticate without storing the GitHub App client secret on the client.

#### Scenario: CLI starts device login
- **Given** the user runs `clawlens auth login --api-url ...`
- **When** the client calls the server login-start endpoint
- **Then** the server returns a device-login request with user code and verification URI
- **And** the client can poll for completion

#### Scenario: Completed device login returns server-issued tokens
- **Given** the user has approved the GitHub device flow
- **When** the client polls the server login-poll endpoint
- **Then** the server returns a short-lived access token and a refresh token
- **And** the client stores them locally with restricted file permissions

### Requirement: Automation MUST use GitHub App installation authentication
This requirement applies to both pull requests and issues.

The server MUST use GitHub App installation authentication for webhook follow-up calls, hydration, and backfill enumeration.

#### Scenario: Hydrate job fetches PR detail as the installation
- **Given** a hydrate job exists for pull request `#123`
- **When** the server follows up to GitHub for PR detail
- **Then** it authenticates using the GitHub App installation for that repository
- **And** it attributes the API activity to the app installation, not a human user
