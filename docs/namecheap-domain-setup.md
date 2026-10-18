# Connect nova-ai-studio.eu to Render

The purchased domain is **nova-ai-studio.eu** (not .com). The intended public URL is **https://www.nova-ai-studio.eu**.

Render requests:
- `www` CNAME `nova-ai-studio-lhsd.onrender.com`
- `@` A `216.24.57.1` (Namecheap BasicDNS does not offer apex CNAME)

## Namecheap API automation

The utility `scripts/configure_namecheap_dns.py` previews changes by default and only submits them after `--apply` plus typing the domain name. It reads existing records and preserves unrelated entries including email MX/TXT. It replaces conflicting web records at `@` and `www`, including Namecheap URL redirects.

**Prerequisites:** Namecheap API access must be enabled on the account, the calling public IPv4 address must be whitelisted in Namecheap, and the domain must use Namecheap DNS. Namecheap may restrict API access depending on account eligibility. Never put credentials into GitHub or Render environment settings for this one-off task.

Set these environment variables privately in your local terminal or approved secure runner:
- `NAMECHEAP_API_USER`
- `NAMECHEAP_USERNAME`
- `NAMECHEAP_API_KEY`
- `NAMECHEAP_CLIENT_IP` (whitelisted public IPv4 of the machine running the script)

Preview: `python3 scripts/configure_namecheap_dns.py`

Apply after reviewing the preview: `python3 scripts/configure_namecheap_dns.py --apply`

**Caution:** Namecheap's `setHosts` API replaces the entire DNS zone. The script preserves common DNS record fields but some advanced/proprietary records may not round-trip correctly. Review all existing records and export/backup DNS before applying, especially if using custom email or advanced routing. If Namecheap redirects are configured in the Domain tab, confirm their removal in Advanced DNS. If the domain uses custom nameservers, configure records at the authoritative DNS provider instead.

After propagation, open https://dashboard.render.com/web/srv-dbaagrm1egvs739vsbjg and choose Settings → Custom Domains → Retry Verification for both `nova-ai-studio.eu` and `www.nova-ai-studio.eu`. Render provisions HTTPS after verification. Leave the Render subdomain enabled until successful.

This repository cannot grant Namecheap API access or guarantee that the domain is live; those steps require account authorization and DNS verification.
