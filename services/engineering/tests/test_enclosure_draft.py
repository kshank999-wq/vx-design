"""Drafted enclosure walls (for injection molded parts), checked on a synthetic board without KiCad."""
import math
import unittest

try:
    import cadquery as cq
except ImportError:   # the geometry kernel is in the engineering image
    cq = None

from vx_eng.enclosure import EnclosureSpec, build


@unittest.skipIf(cq is None, "cadquery is not installed")
class DraftTest(unittest.TestCase):
    def setUp(self):
        self.board = cq.Solid.makeBox(60, 40, 1.6)
        self.facts = {"thickness_mm": 1.6, "holes": [{"ref": "H1", "x": 5, "y": 5, "size": "M3"}, {"ref": "H2", "x": 55, "y": 35, "size": "M3"}]}

    def spec(self, draft):
        return EnclosureSpec.from_json({"process": "fdm", "material": "PETG", "wall_mm": 2, "edge_gap_mm": 0.5, "top_clearance_mm": 6,
                                        "standoff_height_mm": 6, "fastening": "heat_set_insert", "openings": [], "draft_deg": draft})

    def side_faces(self, solid):
        """(area, draft in degrees) of every non-horizontal face, measured at its centre."""
        out = []
        for f in solid.Faces():
            n = f.normalAt()
            if abs(n.z) < 0.99:
                out.append((f.Area(), math.degrees(math.asin(min(1.0, abs(n.z))))))
        return out

    def test_lid_is_one_piece(self):
        for d in (0, 2):
            b = build(self.spec(d), self.board, {}, self.facts)
            self.assertEqual(len(b["lid"].Solids()), 1, f"draft {d}: the lip is joined to the lid")
            self.assertEqual(len(b["base"].Solids()), 1)

    def test_straight_walls_without_draft(self):
        b = build(self.spec(0), self.board, {}, self.facts)
        self.assertEqual(b["levels"]["draft_deg"], 0)
        drafts = [d for _, d in self.side_faces(b["base"])]
        self.assertTrue(all(d < 0.01 for d in drafts))

    def test_drafted_walls_release_and_still_fit(self):
        b = build(self.spec(2), self.board, {}, self.facts)
        self.assertEqual(b["levels"]["draft_deg"], 2)
        for part in ("base", "lid"):
            solid = b[part]
            self.assertTrue(solid.isValid(), part)
            faces = self.side_faces(solid)
            area = sum(a for a, _ in faces)
            drafted = sum(a for a, d in faces if d >= 1.9)
            # Fastener holes in the bosses stay straight (insert fit); everything else is drafted.
            self.assertGreater(drafted / area, 0.9, f"{part}: {drafted / area:.2%} of the side surface drafted")
        # The inside never gets narrower than the straight cavity: inside the cavity there is no more material than the
        # straight build puts there (bosses and the lip), so the fit checks stay valid.
        straight = build(self.spec(0), self.board, {}, self.facts)
        for part in ("base", "lid"):
            self.assertLessEqual(b[part].intersect(b["cavity"]).Volume(), straight[part].intersect(straight["cavity"]).Volume() + 0.5, part)
        # The molded lip joint: base and lid do not overlap, the lip sits in the base's step.
        self.assertLess(b["base"].intersect(b["lid"]).Volume(), 1e-3)
        # Base and lid meet at the split with the same outline.
        split = b["levels"]["split"]
        bb, lb = b["base"].BoundingBox(), b["lid"].BoundingBox()
        self.assertAlmostEqual(bb.xlen, lb.xlen, places=2)
        self.assertLessEqual(bb.zmax, split + 0.01)


    def test_low_lid_keeps_its_top(self):
        for d in (0, 2):
            spec = self.spec(d)
            spec.top_clearance_mm = 0.2   # the lid's side wall is shorter than the lip's ledge
            b = build(spec, self.board, {}, self.facts)
            self.assertAlmostEqual(b["lid"].BoundingBox().zmax, b["levels"]["top_outer"], places=2)
            self.assertEqual(len(b["lid"].Solids()), 1)

    def test_wall_too_thin_for_a_molded_lip(self):
        from vx_eng import kicad
        spec = self.spec(2)
        spec.wall_mm = 1.2
        with self.assertRaisesRegex(kicad.KicadError, "too thin for a molded lip joint"):
            build(spec, self.board, {}, self.facts)


if __name__ == "__main__":
    unittest.main()
