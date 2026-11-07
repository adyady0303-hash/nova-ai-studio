#!/usr/bin/env python3
"""Safely prepare Namecheap DNS for Nova AI Studio.

Default mode previews changes. --apply requires explicit approval and Namecheap
API credentials. Namecheap setHosts replaces the complete zone, so all unrelated
records are preserved and the zone is re-read immediately before applying.
"""
import argparse
import os
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

DOMAIN = "nova-ai-studio.eu"
TARGET = "nova-ai-studio-lhsd.onrender.com"
IP = "216.24.57.1"
API_URL = "https://api.namecheap.com/xml.response"
NS = {"n": "http://api.namecheap.com/xml.response"}


def request(command, fields):
    params = {
        "ApiUser": os.environ["NAMECHEAP_API_USER"],
        "ApiKey": os.environ["NAMECHEAP_API_KEY"],
        "UserName": os.environ["NAMECHEAP_USERNAME"],
        "ClientIp": os.environ["NAMECHEAP_CLIENT_IP"],
        "Command": command,
        **fields,
    }
    data = urllib.parse.urlencode(params).encode()
    with urllib.request.urlopen(urllib.request.Request(API_URL, data=data), timeout=25) as resp:
        root = ET.fromstring(resp.read())
    if root.attrib.get("Status") != "OK":
        errors = [e.text for e in root.findall(".//n:Error", NS)]
        raise RuntimeError("Namecheap API error: " + "; ".join(x or "unknown" for x in errors))
    return root


def get_hosts():
    root = request("namecheap.domains.dns.getHosts", {"SLD": "nova-ai-studio", "TLD": "eu"})
    return [dict(x.attrib) for x in root.findall(".//n:host", NS)]


def plan(hosts):
    # Remove only conflicting web records. Keep MX, TXT, SPF, DKIM, DMARC, etc.
    conflict_types = {"A", "AAAA", "CNAME", "URL", "URL301", "FRAME"}
    kept, removed = [], []
    for host in hosts:
        name = host.get("Name", "")
        typ = host.get("Type", "").upper()
        if name in ("@", "www") and typ in conflict_types:
            removed.append(host)
        else:
            kept.append(host)
    desired = [
        {"Name": "@", "Type": "A", "Address": IP, "TTL": "1800"},
        {"Name": "www", "Type": "CNAME", "Address": TARGET, "TTL": "1800"},
    ]
    return kept + desired, removed


def apply(hosts):
    # API requires contiguous HostNameN / RecordTypeN / AddressN fields.
    fields = {"SLD": "nova-ai-studio", "TLD": "eu"}
    for i, h in enumerate(hosts, 1):
        fields[f"HostName{i}"] = h["Name"]
        fields[f"RecordType{i}"] = h["Type"]
        fields[f"Address{i}"] = h["Address"]
        fields[f"TTL{i}"] = h.get("TTL") or "1800"
        if h.get("MXPref") and h["Type"].upper() == "MX":
            fields[f"MXPref{i}"] = h["MXPref"]
    request("namecheap.domains.dns.setHosts", fields)


def main():
    parser = argparse.ArgumentParser(description="Preview or configure nova-ai-studio.eu DNS in Namecheap")
    parser.add_argument("--apply", action="store_true", help="Write DNS changes after interactive confirmation")
    args = parser.parse_args()
    required = ("NAMECHEAP_API_USER", "NAMECHEAP_API_KEY", "NAMECHEAP_USERNAME", "NAMECHEAP_CLIENT_IP")
    missing = [x for x in required if not os.getenv(x)]
    if missing:
        sys.exit("Missing environment variables: " + ", ".join(missing))
    current = get_hosts()
    desired, removed = plan(current)
    print(f"Domain: {DOMAIN}; existing records: {len(current)}")
    for h in removed:
        print(f"REPLACE: {h.get('Name')} {h.get('Type')} {h.get('Address')}")
    print(f"SET: @ A {IP}")
    print(f"SET: www CNAME {TARGET}")
    print(f"PRESERVE: {len(desired)-2} other DNS records")
    if not args.apply:
        print("DRY RUN: no DNS records were changed. Use --apply to authorize changes.")
        return
    answer = input(f"Type {DOMAIN} to approve replacing the full Namecheap DNS zone: ")
    if answer != DOMAIN:
        sys.exit("Cancelled; no changes made.")
    # Re-read to avoid overwriting intervening edits.
    fresh = get_hosts()
    if fresh != current:
        sys.exit("DNS changed since preview; cancelled. Run again.")
    apply(desired)
    print("DNS update submitted. Check propagation and Render domain verification.")


if __name__ == "__main__":
    main()
