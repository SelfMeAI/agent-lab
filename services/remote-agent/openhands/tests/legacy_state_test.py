import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "extension"))
from legacy_state import input_senders, migrate_owned_volume, private_file


class RenameTests(unittest.TestCase):
    def test_preserves_owned_volume_and_native_absolute_paths(self):
        with tempfile.TemporaryDirectory(prefix="agent-lab-rename-") as directory:
            root = Path(directory).resolve()
            (root / "selfme/tasks").mkdir(parents=True)
            (root / "selfme/tasks/artifact.txt").write_text("retained artifact")
            (root / ".selfme-inputs").mkdir()
            (root / ".selfme-inputs/queue.sqlite").write_bytes(b"retained native outbox")
            migrate_owned_volume(root)
            migrate_owned_volume(root)
            self.assertEqual((root / "agent-lab/tasks/artifact.txt").read_text(), "retained artifact")
            self.assertEqual((root / "selfme/tasks/artifact.txt").read_text(), "retained artifact")
            self.assertEqual((root / ".agent-lab-inputs/queue.sqlite").read_bytes(), b"retained native outbox")

    def test_never_merges_profiles_or_follows_an_unknown_alias(self):
        with tempfile.TemporaryDirectory(prefix="agent-lab-rename-") as directory:
            root = Path(directory).resolve()
            (root / "selfme").mkdir()
            (root / "agent-lab").mkdir()
            with self.assertRaisesRegex(RuntimeError, "同时存在"):
                migrate_owned_volume(root)

    def test_keeps_old_receipts_and_internal_files_protected(self):
        self.assertEqual(input_senders("id"), ("agent-lab-input:id", "selfme-input:id"))
        self.assertTrue(private_file(".selfme-secret"))
        self.assertTrue(private_file(".agent-lab-secret"))
        self.assertFalse(private_file("document.txt"))


if __name__ == "__main__":
    unittest.main()
