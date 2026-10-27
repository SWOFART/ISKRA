"""Accept only the intentional PostgreSQL assertion failure, with no other errors."""


def validate_probe(return_code, report, metadata):
    if (return_code != 1 or report.get("success") is not False
            or report.get("numFailedTests") != 1
            or metadata.get("unhandledErrors") != 0 or metadata.get("suiteErrors") != 0
            or metadata.get("reason") != "failed"):
        raise ValueError("Expected a failed run with only the deliberate assertion and no unhandled errors")
    files = report.get("testResults", [])
    failed = [result for result in files if result.get("status") == "failed"]
    if (len(failed) != 1 or any(result.get("status") not in ("passed", "failed") for result in files)
            or failed[0].get("message") != ""
            or not failed[0].get("name", "").replace("\\", "/").endswith("/tests/integration/auth/postgres.test.ts")):
        raise ValueError("Unexpected file-level failure in negative probe")
    assertions = [a for result in files for a in result.get("assertionResults", []) if a.get("status") == "failed"]
    if (len(assertions) != 1
            or assertions[0].get("title") != "detects an intentionally violated SQL invariant"
            or not any(message.startswith("AssertionError: ISKRA_HARNESS_EXPECTED_FAILURE")
                       for message in assertions[0].get("failureMessages", []))):
        raise ValueError("Expected exactly the deliberate PostgreSQL assertion failure")
