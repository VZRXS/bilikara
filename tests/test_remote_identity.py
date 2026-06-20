import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from bilikara.remote_identity import RemoteIdentityStore


class RemoteIdentityStoreTest(unittest.TestCase):
    def test_token_is_hashed_and_survives_store_reload(self):
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "remote_identities.json"
            store = RemoteIdentityStore(path)
            token = store.issue("Kevin")

            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertNotIn(token, path.read_text(encoding="utf-8"))
            self.assertEqual(len(next(iter(payload["identities"]))), 64)
            self.assertEqual(RemoteIdentityStore(path).resolve(token), "Kevin")

    def test_rotate_session_invalidates_existing_tokens(self):
        with TemporaryDirectory() as tmpdir:
            store = RemoteIdentityStore(Path(tmpdir) / "remote_identities.json")
            previous_session_id = store.snapshot_session_id()
            token = store.issue("Kevin")

            next_session_id = store.rotate_session()

            self.assertNotEqual(next_session_id, previous_session_id)
            self.assertEqual(store.resolve(token), "")

    def test_rename_and_revoke_keep_token_identity_consistent(self):
        with TemporaryDirectory() as tmpdir:
            store = RemoteIdentityStore(Path(tmpdir) / "remote_identities.json")
            token = store.issue("Kevin")

            self.assertTrue(store.rename(token, "VZRXS"))
            self.assertEqual(store.resolve(token), "VZRXS")
            self.assertEqual(store.revoke_name("VZRXS"), 1)
            self.assertEqual(store.resolve(token), "")

    def test_invalid_persisted_timestamps_do_not_block_startup(self):
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "remote_identities.json"
            digest = "a" * 64
            path.write_text(
                json.dumps(
                    {
                        "session_id": "session",
                        "identities": {
                            digest: {
                                "name": "Kevin",
                                "created_at": "invalid",
                                "updated_at": {},
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            store = RemoteIdentityStore(path)

            self.assertEqual(store.identities[digest]["created_at"], 0.0)
            self.assertEqual(store.identities[digest]["updated_at"], 0.0)


if __name__ == "__main__":
    unittest.main()
