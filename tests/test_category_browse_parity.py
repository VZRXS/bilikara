import re
import unittest
from pathlib import Path


class CategoryBrowseParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        static_dir = Path(__file__).resolve().parents[1] / "static"
        cls.host_source = (static_dir / "app.js").read_text(encoding="utf-8")
        cls.remote_source = (static_dir / "remote.js").read_text(encoding="utf-8")

    @staticmethod
    def _quoted_values(source: str, pattern: str) -> list[str]:
        match = re.search(pattern, source, re.DOTALL)
        if not match:
            raise AssertionError(f"missing category declaration: {pattern}")
        return re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"', match.group(1))

    @classmethod
    def _definitions(cls, source: str, declaration: str) -> dict[str, list[str]]:
        match = re.search(
            rf"const {declaration} = \[(.*?)\n\];",
            source,
            re.DOTALL,
        )
        if not match:
            raise AssertionError(f"missing category definitions: {declaration}")
        definitions: dict[str, list[str]] = {}
        for key, raw_tags in re.findall(
            r'\{\s*key:\s*"([^"]+)",\s*tags:\s*\[(.*?)\]\s*\}',
            match.group(1),
            re.DOTALL,
        ):
            definitions[key] = re.findall(r'"([^"]+)"', raw_tags)
        return definitions

    def test_remote_category_definitions_match_host(self):
        self.assertEqual(
            self._definitions(self.remote_source, "categoryBrowseDefinitionsRaw"),
            self._definitions(self.host_source, "CATEGORY_BROWSE_DEFINITIONS"),
        )

    def test_remote_full_field_tags_match_host(self):
        remote_tags = self._quoted_values(
            self.remote_source,
            r"const categoryBrowseFullFieldTags = new Set\(\[(.*?)\]\.map",
        )
        host_tags = self._quoted_values(
            self.host_source,
            r"const CATEGORY_BROWSE_FULL_FIELD_TAGS = new Set\(\[(.*?)\]\.map",
        )
        self.assertEqual(remote_tags, host_tags)


if __name__ == "__main__":
    unittest.main()
