use std::io::{self, Read};
use syn::File;
use syn::visit_mut::VisitMut;
use quote::quote;

struct AttributeStripper;

impl VisitMut for AttributeStripper {
    fn visit_item_mut(&mut self, i: &mut syn::Item) {
        // Strip attributes from all items
        match i {
            syn::Item::Fn(item) => item.attrs.clear(),
            syn::Item::Struct(item) => item.attrs.clear(),
            syn::Item::Enum(item) => item.attrs.clear(),
            syn::Item::Mod(item) => item.attrs.clear(),
            syn::Item::Trait(item) => item.attrs.clear(),
            syn::Item::Impl(item) => item.attrs.clear(),
            syn::Item::Type(item) => item.attrs.clear(),
            syn::Item::Const(item) => item.attrs.clear(),
            syn::Item::Static(item) => item.attrs.clear(),
            syn::Item::Use(item) => item.attrs.clear(),
            syn::Item::ExternCrate(item) => item.attrs.clear(),
            syn::Item::ForeignMod(item) => item.attrs.clear(),
            syn::Item::Macro(item) => item.attrs.clear(),
            _ => {}
        }
        syn::visit_mut::visit_item_mut(self, i);
    }

    fn visit_file_mut(&mut self, i: &mut syn::File) {
        i.attrs.clear(); // remove #![...]
        syn::visit_mut::visit_file_mut(self, i);
    }
}

fn main() {
    let mut source = String::new();
    if let Err(_) = io::stdin().read_to_string(&mut source) {
        std::process::exit(1);
    }

    match syn::parse_file(&source) {
        Ok(mut ast) => {
            let mut stripper = AttributeStripper;
            stripper.visit_file_mut(&mut ast);
            
            // quote! drops all comments and formatting, giving us a pure AST logic representation
            let normalized = quote!(#ast).to_string();
            // remove spaces before punctuation to match original typescript output loosely
            let no_spaces = normalized.replace(" ! ", "!").replace(" (", "(").replace(" ,", ",").replace(" )", ")");
            print!("{}", no_spaces);
        }
        Err(_) => {
            // Fallback
            print!("{}", source.replace("\n", " ").trim());
        }
    }
}
