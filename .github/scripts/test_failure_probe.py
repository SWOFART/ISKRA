import copy
import unittest

from check_failure_probe import validate_probe


class FailureProbeTests(unittest.TestCase):
    def setUp(self):
        self.report = {
            "success": False, "numFailedTests": 1, "numFailedTestSuites": 2,
            "testResults": [{
                "name": "/workspace/tests/integration/auth/postgres.test.ts", "status": "failed", "message": "",
                "assertionResults": [{"title": "detects an intentionally violated SQL invariant", "status": "failed",
                                      "failureMessages": ["AssertionError: ISKRA_HARNESS_EXPECTED_FAILURE: expected 1 to be 2"]}],
            }],
        }
        self.metadata = {"unhandledErrors": 0, "suiteErrors": 0, "reason": "failed"}

    def test_accepts_only_expected_failure_including_nested_describe_suite_counts(self):
        validate_probe(1, self.report, self.metadata)
        self.report["testResults"].append({"status": "passed", "assertionResults": []})
        validate_probe(1, self.report, self.metadata)

    def test_rejects_collection_failure_in_another_file(self):
        self.report["testResults"].append({"status": "failed", "message": "Syntax error", "assertionResults": []})
        with self.assertRaises(ValueError):
            validate_probe(1, self.report, self.metadata)

    def test_rejects_setup_error_in_the_expected_file(self):
        self.report["testResults"][0]["message"] = "Setup failed"
        with self.assertRaises(ValueError):
            validate_probe(1, self.report, self.metadata)

    def test_rejects_unhandled_errors_and_missing_reporter_metadata(self):
        for metadata in [{}, {**self.metadata, "unhandledErrors": 1},
                         {**self.metadata, "suiteErrors": 1}, {**self.metadata, "reason": "interrupted"}]:
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                validate_probe(1, self.report, metadata)

    def test_rejects_unrelated_assertions_files_or_exit_codes(self):
        for mutation in ["title", "message", "file", "extra"]:
            report = copy.deepcopy(self.report)
            result = report["testResults"][0]
            if mutation == "title": result["assertionResults"][0]["title"] = "some other test"
            if mutation == "message": result["assertionResults"][0]["failureMessages"] = ["Connection failed"]
            if mutation == "file": result["name"] = "/workspace/tests/integration/domain/unrelated.test.ts"
            if mutation == "extra": result["assertionResults"].append(result["assertionResults"][0])
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate_probe(1, report, self.metadata)
        with self.assertRaises(ValueError): validate_probe(0, self.report, self.metadata)


if __name__ == "__main__":
    unittest.main()
