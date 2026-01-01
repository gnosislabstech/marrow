// P11 — privacy pre-scan catches the secret shapes a real corpus carries:
// private key blocks, cloud/provider tokens, unquoted passwords, and
// credentialed connection strings. Benign prose must pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privacyPreScan } from "../src/privacy.js";

const QUARANTINED: Array<[string, string]> = [
  ["private key block", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA"], // gitleaks:allow — synthetic needle
  ["rsa private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA"], // gitleaks:allow — synthetic needle
  ["aws access key id", "aws_access_key_id = AKIAIOSFODNN7EXAMPLE"], // gitleaks:allow — synthetic needle
  ["aws temp key id", "ASIAIOSFODNN7EXAMPLE"], // gitleaks:allow — synthetic needle
  ["github fine-grained pat", "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789"], // gitleaks:allow — synthetic needle
  ["github oauth token", "gho_16C7e42F292c6912E7710c838347Ae178B4a"], // gitleaks:allow — synthetic needle
  ["stripe live key", "sk_live_4eC39HqLyjWDarjtT1zdp7dc"], // gitleaks:allow — synthetic needle
  ["slack bot token", "xoxb-17653672481-19874698323-pdFZKHtTuE3sbYCfoO1yBPvt"], // gitleaks:allow — synthetic needle
  ["unquoted password", "password=hunter2abc"], // gitleaks:allow — synthetic needle
  ["unquoted passwd", "passwd: s3cr3t-value-99"], // gitleaks:allow — synthetic needle
  ["mysql url with creds", "mysql://admin:p4ssw0rd@db.internal:3306/app"],
  ["redis url with creds", "redis://default:supersecret@redis.internal:6379"],
  ["mongodb url with creds", "mongodb+srv://user:passw0rd@cluster0.example.net/app"],
];

for (const [name, text] of QUARANTINED) {
  test(`P11: quarantines ${name}`, () => {
    assert.equal(privacyPreScan(text).pass, false, `should quarantine: ${text}`);
  });
}

const PASSING: Array<[string, string]> = [
  ["benign prose", "We refactored the password reset flow to use signed tokens."],
  ["short password value", "password=short"], // gitleaks:allow — synthetic needle
  ["public stripe test key shape absent", "we use stripe for billing"],
  ["plain postgres mention", "the postgres:// scheme has no creds here"],
];

for (const [name, text] of PASSING) {
  test(`P11: passes ${name}`, () => {
    assert.equal(privacyPreScan(text).pass, true, `should pass: ${text}`);
  });
}
