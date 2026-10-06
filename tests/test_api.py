import json
import tempfile
import unittest
from pathlib import Path
from fastapi.testclient import TestClient
import main


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = main.DB_PATH
        main.DB_PATH = Path(self.temp.name) / "test.db"
        self.client = TestClient(main.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        main.DB_PATH = self.old
        self.temp.cleanup()

    def test_health_and_public_assets(self):
        self.assertEqual(self.client.get("/health").json()["version"], "2.0.0")
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/engine.js").status_code, 200)
        for path in ["/signal_bot.db", "/main.py", "/requirements.txt"]:
            self.assertEqual(self.client.get(path).status_code, 404)

    def test_config_backtest_roundtrip_and_delete_reference(self):
        config = self.client.post(
            "/configs", json={"name": " Rule ", "params": {"rsi": 40}}
        )
        self.assertEqual(config.status_code, 201)
        c = config.json()
        self.assertEqual(c["name"], "Rule")
        payload = {
            "name": "Trial",
            "config_id": c["id"],
            "metrics": {"return": 0.1},
            "trades": [{"symbol": "TEST", "pnl": 50}],
        }
        saved = self.client.post("/backtests", json=payload)
        self.assertEqual(saved.status_code, 201)
        id = saved.json()["id"]
        detail = self.client.get(f"/backtests/{id}").json()
        self.assertEqual(detail["trades"], payload["trades"])
        self.assertEqual(len(self.client.get("/backtests").json()), 1)
        self.client.delete(f'/configs/{c["id"]}')
        self.assertIsNone(self.client.get(f"/backtests/{id}").json()["config_id"])
        self.assertEqual(self.client.delete(f"/backtests/{id}").status_code, 200)
        self.assertEqual(self.client.get(f"/backtests/{id}").status_code, 404)

    def test_missing_configuration_and_bounded_names(self):
        payload = {"name": "bad", "config_id": 999, "metrics": {}, "trades": []}
        self.assertEqual(self.client.post("/backtests", json=payload).status_code, 404)
        for name in ["", "   ", "x" * 81]:
            self.assertEqual(
                self.client.post(
                    "/configs", json={"name": name, "params": {}}
                ).status_code,
                422,
            )
        self.assertEqual(self.client.get("/configs?limit=1000").status_code, 422)

    def test_nested_nonfinite_values_rejected(self):
        with self.assertRaises(ValueError):
            main.ConfigIn(name="bad", params={"nested": {"value": float("inf")}})

    def test_report_persistence(self):
        report = json.loads(
            (main.ROOT / "examples/synthetic-experiment.json").read_text()
        )
        saved = self.client.post(
            "/experiments", json={"name": "Synthetic fixture", "report": report}
        )
        self.assertEqual(saved.status_code, 201)
        id = saved.json()["id"]
        self.assertEqual(self.client.get(f"/experiments/{id}").json()["report"], report)
        self.assertEqual(
            self.client.get("/experiments").json()[0]["dataset"]["kind"], "synthetic"
        )
        self.assertEqual(self.client.delete(f"/experiments/{id}").status_code, 200)
        self.assertEqual(self.client.get(f"/experiments/{id}").status_code, 404)

    def test_invalid_report_and_missing_deletes(self):
        self.assertEqual(
            self.client.post(
                "/experiments", json={"name": "bad", "report": {"version": "1"}}
            ).status_code,
            422,
        )
        for path in ["/configs/999", "/backtests/999", "/experiments/999"]:
            self.assertEqual(self.client.delete(path).status_code, 404)


if __name__ == "__main__":
    unittest.main()
