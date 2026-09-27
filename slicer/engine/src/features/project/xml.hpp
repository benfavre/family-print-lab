#pragma once
#include <cctype>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace printlab::project_io {
struct Xml {
	std::string name, text;
	std::map<std::string, std::string> attrs;
	std::vector<Xml> children;
	size_t start = 0, end = 0, inner_start = 0, inner_end = 0;
	std::string attr(const std::string &key, const std::string &fallback = "") const {
		auto it = attrs.find(key);
		return it == attrs.end() ? fallback : it->second;
	}
	const Xml *child(const std::string &key) const {
		for (const auto &c : children)
			if (c.name == key)
				return &c;
		return nullptr;
	}
};
inline std::string escape(const std::string &text) {
	std::string out;
	for (char c : text)
		switch (c) {
		case '&':
			out += "&amp;";
			break;
		case '<':
			out += "&lt;";
			break;
		case '>':
			out += "&gt;";
			break;
		case '"':
			out += "&quot;";
			break;
		case '\'':
			out += "&apos;";
			break;
		default:
			out += c;
		}
	return out;
}
inline std::string unescape(const std::string &text, bool metadata = false) {
	std::string out;
	for (size_t i = 0; i < text.size(); ++i) {
		if (text[i] != '&') {
			out += text[i];
			continue;
		}
		auto end = text.find(';', i);
		if (end == std::string::npos || end - i > 16) {
			out += '&';
			continue;
		}
		auto e = text.substr(i + 1, end - i - 1);
		if (e == "lt")
			out += '<';
		else if (e == "gt")
			out += '>';
		else if (e == "amp")
			out += '&';
		else if (!metadata && e == "quot")
			out += '"';
		else if (!metadata && e == "apos")
			out += '\'';
		else if (!metadata && !e.empty() && e[0] == '#') {
			unsigned long cp;
			try {
				cp = std::stoul(e.substr(e.size() > 1 && e[1] == 'x' ? 2 : 1), nullptr,
								e.size() > 1 && e[1] == 'x' ? 16 : 10);
			} catch (...) {
				throw std::invalid_argument("Invalid XML character reference.");
			}
			if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
				throw std::invalid_argument("Invalid XML character reference.");
			if (cp < 0x80)
				out += char(cp);
			else if (cp < 0x800) {
				out += char(0xc0 | (cp >> 6));
				out += char(0x80 | (cp & 63));
			} else if (cp < 0x10000) {
				out += char(0xe0 | (cp >> 12));
				out += char(0x80 | ((cp >> 6) & 63));
				out += char(0x80 | (cp & 63));
			} else {
				out += char(0xf0 | (cp >> 18));
				out += char(0x80 | ((cp >> 12) & 63));
				out += char(0x80 | ((cp >> 6) & 63));
				out += char(0x80 | (cp & 63));
			}
		} else {
			out += text.substr(i, end - i + 1);
		}
		i = end;
	}
	return out;
}
class XmlParser {
	const std::string &s;
	size_t pos = 0;
	bool raw_mesh;
	void ws() {
		while (pos < s.size() && std::isspace(static_cast<unsigned char>(s[pos])))
			++pos;
	}
	std::string name() {
		size_t start = pos;
		while (pos < s.size() && !std::isspace(static_cast<unsigned char>(s[pos])) && s[pos] != '=' && s[pos] != '/' &&
			   s[pos] != '>')
			++pos;
		if (start == pos)
			throw std::invalid_argument("Missing XML name.");
		return s.substr(start, pos - start);
	}
	void skip(const std::string &end) {
		auto at = s.find(end, pos);
		if (at == std::string::npos)
			throw std::invalid_argument("Unclosed XML declaration.");
		pos = at + end.size();
	}
	Xml element(unsigned depth) {
		if (depth > 64)
			throw std::invalid_argument("XML nesting is too deep.");
		Xml n;
		n.start = pos++;
		n.name = name();
		ws();
		while (pos < s.size() && s[pos] != '/' && s[pos] != '>') {
			auto key = name();
			ws();
			if (pos >= s.size() || s[pos++] != '=')
				throw std::invalid_argument("Bad XML attribute.");
			ws();
			if (pos >= s.size() || (s[pos] != '\'' && s[pos] != '"'))
				throw std::invalid_argument("Unquoted XML attribute.");
			char quote = s[pos++];
			size_t start = pos;
			auto end = s.find(quote, pos);
			if (end == std::string::npos)
				throw std::invalid_argument("Unclosed XML attribute.");
			n.attrs[key] = unescape(s.substr(start, end - start));
			pos = end + 1;
			ws();
		}
		bool self = pos < s.size() && s[pos] == '/';
		if (self)
			++pos;
		if (pos >= s.size() || s[pos++] != '>')
			throw std::invalid_argument("Unclosed XML tag.");
		n.inner_start = n.inner_end = n.end = pos;
		if (self)
			return n;
		if (raw_mesh && n.name == "mesh") {
			auto close = s.find("</mesh", pos);
			if (close == std::string::npos)
				throw std::invalid_argument("Unclosed mesh.");
			n.inner_end = close;
			pos = close;
			skip(">");
			n.end = pos;
			return n;
		}
		while (pos < s.size()) {
			if (s.compare(pos, 4, "<!--") == 0) {
				skip("-->");
				continue;
			}
			if (s.compare(pos, 9, "<![CDATA[") == 0) {
				auto end = s.find("]]>", pos + 9);
				if (end == std::string::npos)
					throw std::invalid_argument("Unclosed CDATA.");
				n.text += s.substr(pos + 9, end - pos - 9);
				pos = end + 3;
				continue;
			}
			if (s.compare(pos, 2, "</") == 0) {
				n.inner_end = pos;
				pos += 2;
				auto close = name();
				ws();
				if (close != n.name || pos >= s.size() || s[pos++] != '>')
					throw std::invalid_argument("Mismatched XML closing tag.");
				n.end = pos;
				return n;
			}
			if (s[pos] == '<') {
				if (s.compare(pos, 2, "<!") == 0)
					throw std::invalid_argument("XML declarations inside a model are not supported.");
				n.children.push_back(element(depth + 1));
			} else {
				auto end = s.find('<', pos);
				if (end == std::string::npos)
					throw std::invalid_argument("Unclosed XML element.");
				n.text += unescape(s.substr(pos, end - pos));
				pos = end;
			}
		}
		throw std::invalid_argument("Unclosed XML element.");
	}

  public:
	XmlParser(const std::string &text, bool raw = true) : s(text), raw_mesh(raw) {}
	Xml parse() {
		if (s.compare(0, 3, "\xef\xbb\xbf") == 0)
			pos = 3;
		for (;;) {
			ws();
			if (s.compare(pos, 2, "<?") == 0)
				skip("?>");
			else if (s.compare(pos, 4, "<!--") == 0)
				skip("-->");
			else
				break;
		}
		if (pos >= s.size() || s[pos] != '<' || s.compare(pos, 2, "<!") == 0)
			throw std::invalid_argument("Missing XML root element.");
		auto result = element(0);
		ws();
		if (pos != s.size())
			throw std::invalid_argument("Unexpected text after XML document.");
		return result;
	}
};
} // namespace printlab::project_io
