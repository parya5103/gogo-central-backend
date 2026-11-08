# GoGo Central Backend — Agent Instructions

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context

### Terminology
- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators.
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM.
- Say "AWS Settings" for management tasks at https://settings.aws.com/ (project management, billing, team members, spend limits). Users view actual AWS resources in the AWS Management Console.
- Say "selected Region" rather than "home Region".
- The user has a managed IAM experience, including managed service control policies (SCPs) and resource control policies (RCPs). IAM policies may still be needed for service-to-service permissions. For SCP/RCP questions, consult https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html.

### Regional and service constraints
- The user's selected Region is `ap-southeast-2`. Confirm it in AWS Settings > View all projects > Overview > Additional Info > Region, or inspect `~/.aws/config` if it cannot be confirmed.
- All regional resources MUST be created in the project's assigned/selected Region. Do not create Lambda, API Gateway, or other regional resources in another Region.
- Do not attempt cross-Region actions, including replication, multi-Region KMS keys, or Route 53 cross-Region routing.
- Do not use Lambda@Edge or CloudFormation StackSets.
- CloudFront is global and may be managed through `us-east-1` where required; this does not permit creating regional Lambda/API Gateway resources there.
- Only use `us-east-1` for AWS Agent Toolkit control-plane commands where its setup instructions explicitly require it; this is not permission to deploy application resources there.
- IAM permissions for human team members are managed by AWS. Do not assign roles to team members unless absolutely necessary.
- If previously working operations suddenly return AccessDenied, ask about configured spend limits and direct the user to AWS Settings > Billing.
- Before AWS work, check whether the user is on the Free or Paid plan and whether relevant services are supported. If a service is unavailable, run `aws freetier get-account-plan-state` and consult the corresponding supported-services list:
  https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html
- Users manage billing, spend limits, and invoices in AWS Settings; budgets and cost optimization are managed in AWS Billing and Cost Management.
- After creating resources, ask whether the user wants successful resources retained or cleaned up, and clearly explain cost implications.
- Never claim an AWS resource was deployed or verified unless the relevant command or service response confirms it.

### Mandatory AWS workflow
- For any AWS task or question (building, configuring, migrating, debugging, operating services, SDK code, CDK/CloudFormation, or AWS behavior), first call `aws___search_documentation` with topic `agent_skills`, then load the matching skill with `aws___retrieve_skill`. Follow current skill guidance over general assumptions.
- Never request or expose AWS passwords, access keys, session tokens, or other secrets in chat, repository files, logs, or commits. Use the AWS CLI browser login flow and local credential storage.
- Keep secrets out of source control; use environment variables or an appropriate secret manager.
- Prefer least privilege, secure defaults, validation, auditable changes, and explicit cost awareness.

## Help level
- **help_level: HIGH**
- Explain each step and why before executing it.
- Suggest safer or better alternatives when appropriate.
- Flag security risks, cost implications, and operational trade-offs.
- Still follow the user's chosen approach when it is safe and permitted; ask before irreversible or materially costly actions.
<!-- END AWS Agent Toolkit rules -->

## Repository-specific operating rules
- Read `KNOWLEDGE.md`, `ARCHITECTURE.md`, `SECURITY.md`, and relevant API/docs before changing backend behavior.
- Preserve existing PostgreSQL runtime, `GoGoDataStore` abstraction, Firebase identity integration, notification delivery safeguards, tests, and the archived Cloudflare Workers/D1 reference implementation unless the user explicitly authorizes a scoped change.
- Do not silently migrate providers, replace persistence, change public API contracts, or provision cloud resources.
- For backend changes, add/update focused tests and run the relevant lint, typecheck, unit, integration, and security checks available in the repository. Report skipped checks honestly.
- Treat `.env`, credentials, service-account files, private keys, tokens, and production data as sensitive; never commit them.
- Make minimal, reviewable changes. Do not force-push, rewrite history, or merge pull requests without explicit authorization.
