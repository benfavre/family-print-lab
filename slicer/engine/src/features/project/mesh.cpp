#include "common.hpp"
#include <cstring>
#include <limits>

namespace printlab::project_io {
namespace {
void u32(std::string &s, size_t at, uint32_t n) {
	for (unsigned i = 0; i < 4; ++i)
		s[at + i] = char(n >> (i * 8));
}
uint32_t u32(const std::string &s, size_t at) {
	uint32_t n = 0;
	for (unsigned i = 0; i < 4; ++i)
		n |= uint32_t(static_cast<unsigned char>(s.at(at + i))) << (i * 8);
	return n;
}
void f32(std::string &s, size_t at, float v) {
	uint32_t n;
	std::memcpy(&n, &v, 4);
	u32(s, at, n);
}
float f32(const std::string &s, size_t at) {
	uint32_t n = u32(s, at);
	float v;
	std::memcpy(&v, &n, 4);
	if (!std::isfinite(v))
		throw std::invalid_argument("Invalid STL coordinate.");
	return v;
}
} // namespace
std::string canonical_stl(const Mesh &mesh) {
	if (mesh.triangles.size() > (std::numeric_limits<uint32_t>::max() - 84) / 50)
		throw std::length_error("Mesh is too large.");
	std::string out(84 + 50 * mesh.triangles.size(), '\0');
	out.replace(0, 16, "Family Print Lab");
	u32(out, 80, static_cast<uint32_t>(mesh.triangles.size()));
	for (size_t i = 0; i < mesh.triangles.size(); ++i) {
		const auto &t = mesh.triangles[i];
		const auto &a = mesh.vertices.at(t[0]), &b = mesh.vertices.at(t[1]), &c = mesh.vertices.at(t[2]);
		double u[3], v[3];
		for (int k = 0; k < 3; ++k) {
			u[k] = double(b[k]) - a[k];
			v[k] = double(c[k]) - a[k];
		}
		double n[3] = {u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]};
		double length = std::hypot(n[0], n[1], n[2]);
		if (length == 0)
			length = 1;
		for (int k = 0; k < 3; ++k)
			f32(out, 84 + i * 50 + k * 4, static_cast<float>(n[k] / length));
		for (int k = 0; k < 3; ++k)
			for (int j = 0; j < 3; ++j)
				f32(out, 84 + i * 50 + 12 + k * 12 + j * 4, mesh.vertices.at(t[k])[j]);
	}
	return out;
}
Mesh stl_mesh(const std::string &s) {
	if (s.size() < 84 || uint64_t(u32(s, 80)) * 50 + 84 != s.size())
		throw std::invalid_argument("Project mesh must be a binary STL.");
	Mesh mesh;
	std::map<std::array<float, 3>, unsigned> index;
	for (size_t i = 0; i < u32(s, 80); ++i) {
		std::array<unsigned, 3> t{};
		for (int k = 0; k < 3; ++k) {
			std::array<float, 3> p{};
			for (int j = 0; j < 3; ++j)
				p[j] = f32(s, 84 + i * 50 + 12 + k * 12 + j * 4);
			auto inserted = index.emplace(p, static_cast<unsigned>(mesh.vertices.size()));
			if (inserted.second)
				mesh.vertices.push_back(p);
			t[k] = inserted.first->second;
		}
		mesh.triangles.push_back(t);
	}
	return mesh;
}
std::string base64(const std::string &s) {
	static const char *digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	std::string out;
	for (size_t i = 0; i < s.size(); i += 3) {
		uint32_t n = uint32_t(static_cast<unsigned char>(s[i])) << 16;
		if (i + 1 < s.size())
			n |= uint32_t(static_cast<unsigned char>(s[i + 1])) << 8;
		if (i + 2 < s.size())
			n |= static_cast<unsigned char>(s[i + 2]);
		out += digits[(n >> 18) & 63];
		out += digits[(n >> 12) & 63];
		out += i + 1 < s.size() ? digits[(n >> 6) & 63] : '=';
		out += i + 2 < s.size() ? digits[n & 63] : '=';
	}
	return out;
}
std::string unbase64(const std::string &s) {
	static const std::string digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	if (s.size() % 4)
		throw std::invalid_argument("Invalid base64 file.");
	std::string out;
	for (size_t i = 0; i < s.size(); i += 4) {
		uint32_t n = 0;
		unsigned pad = 0;
		for (unsigned k = 0; k < 4; ++k) {
			if (s[i + k] == '=') {
				if (k < 2 || i + 4 != s.size())
					throw std::invalid_argument("Invalid base64 padding.");
				++pad;
				n <<= 6;
				continue;
			}
			auto d = digits.find(s[i + k]);
			if (d == std::string::npos || pad)
				throw std::invalid_argument("Invalid base64 file.");
			n = (n << 6) | unsigned(d);
		}
		out += char(n >> 16);
		if (pad < 2)
			out += char(n >> 8);
		if (!pad)
			out += char(n);
	}
	return out;
}
} // namespace printlab::project_io
